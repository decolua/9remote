// Device auth — proof of the v2 key TAIL. The agent registers only the HEAD
// with the Worker, so a server-in-the-middle holding the routing half cannot
// answer the HMAC challenge. Legacy (v1) keys have no split: proof is skipped
// and gating behaves exactly as before.
//
// A phone that paired via QR gets its TAIL through enrollment (over the
// fp2-verified RTC channel); enrollment marks the socket proven, which also
// settles an in-flight proof — so a first QR connect passes without a modal.
import crypto from "crypto";
import { createLogger } from "./logger.js";
import { approveDevice, markTailProven, hasProvenTail, gateDevice, isDeviceKicked, removeDevice } from "./deviceApproval.js";
import { matchesPairingTail, consumePairingTail, getActivePairing } from "./pairingCode.js";
import { CHANNELS, ADMISSION, DEVICE_GATE, TAIL_VERDICT, TAIL_REJECT_REASON } from "./transportConstants.js";
import { tailOf, headOf } from "../cli/utils/apiKey.js";
import { loadKey } from "../cli/utils/state.js";
import { openSealedTail } from "./hostKey.js";

const logger = createLogger("deviceAuth");

function agentTail() {
  return tailOf(loadKey()?.key || "");
}

export function isTailProofEnabled() {
  return !!agentTail();
}

// ── Tail-guess rate limiting (RAM only; a restart clears it — fine, this only
// has to make online guessing slow). The counter anchors on the KEY HEAD, the
// thing actually being guessed: deviceId is client-supplied and rotates freely,
// and behind the tunnel every peer is localhost, so there is no IP to ban.
const TAIL_FAIL_THRESHOLD = 5;               // free misses before the delay kicks in
const TAIL_PENALTY_BASE_MS = 1000;
const TAIL_PENALTY_MAX_MS = 60 * 1000;
const TAIL_FAIL_WINDOW_MS = 60 * 60 * 1000;  // fails older than this expire
const TAIL_PENDING_CAP = 20;                 // penalized sockets held open at once

const tailFailsByKey = new Map(); // keyHead -> ts[]
let tailPendingRejects = 0;

// ── One admission verdict per DEVICE ────────────────────────────────────────
// WS and RTC are two carriers of one connection, so the proof belongs to the
// device, not to whichever socket happened to carry it. Keeping it per-socket
// is what let a rejected device walk back in through a fresh RTC offer
// (AgentBus has no handshake, so it presents nothing to reject) and what
// let an RTC-only session live forever without ever being asked.
//
// deviceId -> { keyHead, state: TAIL_VERDICT, reason: TAIL_REJECT_REASON, since }
const verdicts = new Map();
// Grace for a carrier that cannot present a tail yet (RTC-first: the tail rides
// the WS handshake, or a device:tailProof over the open data channel).
const PROOF_DEADLINE_MS = 20000;

function verdictOf(deviceId, keyHead) {
  const v = deviceId ? verdicts.get(deviceId) : null;
  // A regenerated key retires every verdict made against the old one.
  if (!v || v.keyHead !== keyHead) return null;
  return v;
}

function setVerdict(deviceId, keyHead, state, reason = null) {
  if (!deviceId) return;
  const prev = verdicts.get(deviceId);
  verdicts.set(deviceId, { keyHead, state, reason, since: Date.now() });
  if (state === prev?.state) return;
  // Whoever was waiting on the proof finds out here — one settle, one fan-out.
  if (state === TAIL_VERDICT.proven) flushProofWaiters(deviceId);
  if (state === TAIL_VERDICT.rejected) proofWaiters.delete(deviceId);
}

/** Proof arriving on ANY carrier — handshake auth, or a device:tailProof over
 *  RTC. One entry point, so a device settles once and every carrier sees it. */
export function submitTailProof(deviceId, tail, { pairing = false } = {}) {
  const keyHead = headOf(loadKey()?.key || "");
  // A pairing device holds the CODE's tail and has never seen the key's — the
  // same distinction admissionGate makes, and it has to hold on every road a
  // proof can travel, not just the handshake. Checking the wrong secret here
  // refused a code the gate had already accepted.
  if (!deviceId || (!isTailProofEnabled() && !pairing)) return false;
  const matches = pairing ? consumePairingTail(tail) : verifyKeyTail(tail);
  if (matches) {
    setVerdict(deviceId, keyHead, TAIL_VERDICT.proven);
    markTailProven(deviceId, keyHead);
    logger.info(`[seal] proof accepted: device=${deviceId.slice(0, 8)}`);
    return true;
  }
  const reason = tail === null ? TAIL_REJECT_REASON.sealUnreadable : TAIL_REJECT_REASON.mismatch;
  setVerdict(deviceId, keyHead, TAIL_VERDICT.rejected, reason);
  logger.warn(`[seal] proof rejected (${reason}): device=${deviceId.slice(0, 8)}`);
  return false;
}

/** True while a device is inside its proof grace window (nothing proven yet,
 *  nothing rejected). Carriers may run, but the session must not outlive it. */
export function isProvingExpired(deviceId) {
  const v = verdictOf(deviceId, headOf(loadKey()?.key || ""));
  return !!v && v.state === TAIL_VERDICT.proving && Date.now() - v.since > PROOF_DEADLINE_MS;
}

export function verdictStateOf(deviceId) {
  return verdictOf(deviceId, headOf(loadKey()?.key || ""))?.state || null;
}

// Callbacks waiting for a device to settle its proof — the approval modal is
// the caller: asking the host about a device that cannot prove the key would
// let a click stand in for the proof. deviceId -> Set<fn>
const proofWaiters = new Map();

/**
 * Run `fn` once this device has PROVEN its TAIL (immediately if already
 * proven). No-op for v1 keys, which have nothing to prove.
 *
 * `onExpired` matters when nothing else is holding a deadline: a device that
 * was never admitted has no session, so no session teardown can clean up after
 * it. Without this, a stranger's pending entry would sit forever and its waiter
 * with it. A proof that FAILS drops the waiter silently — that path closes the
 * carriers and answers the client itself.
 */
export function onTailProven(deviceId, fn, onExpired) {
  if (!deviceId || !isTailProofEnabled()) return fn();
  if (verdictStateOf(deviceId) === TAIL_VERDICT.proven) return fn();
  if (!proofWaiters.has(deviceId)) proofWaiters.set(deviceId, new Set());
  proofWaiters.get(deviceId).add(fn);
  if (!onExpired) return;
  setTimeout(() => {
    const set = proofWaiters.get(deviceId);
    if (!set?.delete(fn)) return; // already fired or cleared
    if (!set.size) proofWaiters.delete(deviceId);
    onExpired();
  }, PROOF_DEADLINE_MS);
}

function flushProofWaiters(deviceId) {
  const set = proofWaiters.get(deviceId);
  if (!set) return;
  proofWaiters.delete(deviceId);
  for (const fn of set) { try { fn(); } catch {} }
}

/** Drop anything waiting on a device that will never prove (rejected/timed out). */
export function clearProofWaiters(deviceId) {
  proofWaiters.delete(deviceId);
}

export const PROOF_DEADLINE = PROOF_DEADLINE_MS;

export function noteTailFailure(keyHead) {
  const now = Date.now();
  const fails = (tailFailsByKey.get(keyHead) || []).filter((t) => now - t < TAIL_FAIL_WINDOW_MS);
  fails.push(now);
  tailFailsByKey.set(keyHead, fails);
  // Only WRONG proofs pay the penalty — a client holding the real tail never
  // lands here, so this cannot be turned into a lockout of the rightful device.
  const over = fails.length - TAIL_FAIL_THRESHOLD;
  if (over <= 0) return 0;
  return Math.min(TAIL_PENALTY_BASE_MS * 2 ** (over - 1), TAIL_PENALTY_MAX_MS);
}

/**
 * Is this TAIL the right one? Asked before a client opens a session, so a wrong
 * key can be refused at the login screen instead of after the user has been
 * sent to a workspace that will throw them out.
 *
 * Deliberately answers the same question the gate asks, with the same two
 * secrets — the live code's tail for a pairing, the key's otherwise — and the
 * same rate limit. It settles nothing: no verdict is recorded, no device is
 * involved, and a code is not spent. A client that skips this gets exactly as
 * far, which is what makes answering it safe.
 *
 * @returns {{ok: boolean, reason?: string, penaltyMs?: number}}
 */
export function verifyPresentedTail({ tail, tempKey } = {}) {
  const pairing = !!tempKey;
  if (!pairing && !isTailProofEnabled()) return { ok: true }; // v1 key: nothing to prove
  if (!tail) return { ok: false, reason: TAIL_REJECT_REASON.mismatch, penaltyMs: 0 };

  const matches = pairing ? matchesPairingTail(tail) : verifyKeyTail(tail);
  if (matches) return { ok: true };
  return {
    ok: false,
    reason: TAIL_REJECT_REASON.mismatch,
    penaltyMs: noteTailFailure(headOf(loadKey()?.key || ""))
  };
}

/**
 * The whole admission question, answered in one place, in one order.
 *
 * Two gates, never interleaved: AUTHENTICATE (is this the right key?) then
 * AUTHORIZE (does the host allow this device?). Everything that used to go
 * wrong came from asking them out of order, or from a carrier asking one of
 * them on its own — WS and RTC are two roads to the same door, not two doors.
 *
 * Pure: it reads state and returns a verdict, and writes nothing. Callers act
 * on the result, which is what keeps "deciding" and "doing" from racing.
 *
 * @returns {{step: "auth"|"authz", decision: "admit"|"hold"|"reject", reason?: string}}
 *   step "auth"  — about the key: reject means a wrong TAIL, hold means the
 *                  proof has not arrived yet (the deadline closes it).
 *   step "authz" — about the device: hold means ask the host.
 */
// No carrier argument on purpose: WS and RTC are two protocols for one
// connection, and which one a device arrived on must never change the answer.
export function admissionGate(deviceId, presented, { provenSocket = false, tempKey = null } = {}) {
  const keyHead = headOf(loadKey()?.key || "");
  const gate = gateDevice(deviceId);

  // Before either gate: the host already said no. Nothing the key proves can
  // change that, and holding it for a proof it will never send would only park
  // a refused device in the grace window for the length of the deadline.
  if (gate === DEVICE_GATE.rejected) {
    return { step: "authz", decision: ADMISSION.reject, reason: "device-rejected" };
  }

  // ── Gate 1: authenticate ──────────────────────────────────────────────────
  // One rule for both kinds of key. A one-time code and an API key carry the
  // same kind of secret — minted by the agent, read off its own screen or typed
  // from a saved key, presented back here — so they are checked by the same
  // gate, in the same order, with the same consequences. Only two things
  // differ, and neither is a special case in the flow: which secret the
  // presented TAIL is compared against, and what a miss costs (a code dies, a
  // key does not).
  const pairingSession = !!tempKey && !isDeviceKicked(deviceId);
  // TEMP DIAGNOSTIC — a pairing that cannot be recognised looks exactly like a
  // client that never sent anything; the two need telling apart.
  if (pairingSession) {
    const live = getActivePairing();
    logger.info(`[pair] device=${deviceId?.slice(0, 8)} presented=${presented === undefined ? "none" : String(presented).length + "ch"} ` +
      `liveCode=${live ? "yes" : "no"} liveTail=${live?.tail ? String(live.tail).length + "ch" : "none"} ` +
      `match=${presented === undefined ? "n/a" : matchesPairingTail(String(presented))}`);
  }
  if (isTailProofEnabled() || pairingSession) {
    const verdict = verdictOf(deviceId, keyHead);
    // A standing refusal blocks a carrier that presents NOTHING — that is the
    // RTC restart loop, reconnecting in milliseconds with no new claim, and
    // treating each of those as a fresh chance would make the loop free retries.
    //
    // A carrier that DOES present something is making a new attempt, and gets
    // judged on it. Otherwise one mistyped character would lock a user out of
    // their own machine until the agent restarted, which is the opposite of
    // what a wrong key should cost. Guessing is priced by the rate limiter,
    // not by refusing to look.
    if (verdict?.state === TAIL_VERDICT.rejected && presented === undefined) {
      return { step: "auth", decision: ADMISSION.reject, reason: verdict.reason };
    }
    // A pairing device proves against the live code's TAIL; everyone else
    // against the API key's. Same comparison, different secret.
    const matches = (t) => (pairingSession ? matchesPairingTail(t) : verifyKeyTail(t));
    const proven = provenSocket
      || verdict?.state === TAIL_VERDICT.proven
      || (presented !== undefined && matches(presented));
    if (!proven) {
      // Something was presented and it did not match: settled, wrong key.
      if (presented !== undefined) {
        return {
          step: "auth",
          decision: ADMISSION.reject,
          reason: presented === null ? TAIL_REJECT_REASON.sealUnreadable : TAIL_REJECT_REASON.mismatch
        };
      }
      // Nothing presented yet. Every carrier waits the same way — a handshake
      // carries the tail, signaling and an AgentBus cannot, and the proof
      // follows on device:tailProof. The deadline is what ends this.
      return { step: "auth", decision: ADMISSION.hold, reason: "awaiting-proof" };
    }
  }

  // ── Gate 2: authorize ─────────────────────────────────────────────────────
  // Only reached with the key proven (or a v1 key, which has nothing to prove).
  if (gate === DEVICE_GATE.approved || gate === DEVICE_GATE.auto) {
    return { step: "authz", decision: ADMISSION.admit };
  }
  return { step: "authz", decision: ADMISSION.hold, reason: "host-decides" };
}

/**
 * Does this connection carry the key TAIL?
 *
 * The client sends it verbatim in the handshake. That is safe here and only
 * here: the carriers are a Cloudflare Tunnel to the user's own machine and the
 * RTC data channel — neither is this project's server. The TAIL never goes to
 * the Worker (which stores only the HEAD) nor over the DO signaling relay.
 *
 * Compared in constant time so a wrong value leaks nothing through timing.
 */
export function verifyKeyTail(presentedTail) {
  const tail = agentTail();
  if (!tail || !presentedTail) return false;
  const a = Buffer.from(String(presentedTail), "utf8");
  const b = Buffer.from(tail, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The tail this handshake presents, whichever form it arrived in.
 *
 * `keyTailSealed` is encrypted to this agent's X25519 key: over the WS carrier
 * — a Cloudflare tunnel — a plain tail is readable by whoever holds that path,
 * and the tail is what admits a device. RTC is peer to peer, so a plain tail
 * there is fine and older clients keep working.
 *
 * The three answers are distinct and the caller depends on it: a string is a
 * tail to compare, `null` is "presented something that did not open" (an
 * impostor — never admit), and `undefined` is "presented nothing", which has
 * its own legitimate cases. A seal that fails must not collapse into either of
 * the others, so the plain field is ignored once a sealed one is present.
 *
 * @param {object} auth socket.handshake.auth
 * @param {(sealed: object) => string|null} open unseals with the agent's key
 */
export function presentedTailOf(auth, open) {
  const sealed = auth?.keyTailSealed;
  if (sealed !== undefined) {
    if (!sealed || typeof sealed !== "object" || Array.isArray(sealed)) return null;
    return open(sealed) ?? null;
  }
  return auth?.keyTail;
}

/**
 * Proof over an already-open carrier — the RTC-first case, where no handshake
 * ever carries the tail. Same single verdict as the handshake path; the caller
 * drops the session when this answers false.
 */
export function handleTailProof(socket, data) {
  // Same dual-read as server.authOf: data.auth (normalized) first, handshake fallback.
  const deviceId = socket?.data?.auth?.deviceId || socket.handshake?.auth?.deviceId || socket.deviceId || null;
  // Which secret this device is proving against — the live code if it arrived
  // with one, otherwise the API key. Same question the gate asks; asked here
  // too, because this is the same proof arriving by another road.
  //
  // The code may come from either place: a tunnel handshake carries it, while
  // an RTC-first client has no handshake and sends it with the proof. Reading
  // only the handshake is why a QR pairing over RTC was measured against the
  // API key's tail and refused.
  const presentedTemp = socket.handshake?.auth?.tempKey || data?.tempKey || null;
  const pairing = !!presentedTemp && !!getActivePairing();
  if (!deviceId || (!isTailProofEnabled() && !pairing)) return true;
  const tail = presentedTailOf(data, openSealedTail);
  // Presented nothing: not a guess, so it costs nothing and settles nothing —
  // the proof deadline is what eventually closes an unproven session.
  if (tail === undefined) return true;
  if (submitTailProof(deviceId, tail, { pairing })) return true;
  socket.data.tailReject = {
    reason: tail === null ? TAIL_REJECT_REASON.sealUnreadable : TAIL_REJECT_REASON.mismatch,
    penaltyMs: noteTailFailure(headOf(loadKey()?.key || ""))
  };
  return false;
}

/**
 * Deliver a tail rejection to the client after the rate-limit penalty, then
 * drop the socket. The penalty delays the ANSWER, not the attempt — the socket
 * sits unanswered, so a guess stays expensive while a client holding the real
 * tail is never delayed (its proof never reaches this function).
 */
export function finishTailRejection(socket, onClosed) {
  // route() re-runs decideAdmission after its grace window — one verdict per socket
  if (socket.data?.tailRejectFinished) return;
  socket.data.tailRejectFinished = true;
  const { reason, penaltyMs = 0 } = socket.data?.tailReject || {};
  // The cap bounds how many sockets are held open WAITING, not whether anyone
  // gets an answer: the counter is global, so letting it swallow the reply
  // would let one guesser flooding the agent turn an honest client's typo into
  // a silent drop — no reason, no key cleanup, just a reconnect loop. Past the
  // cap the answer goes out immediately instead of after the penalty.
  const overCap = tailPendingRejects >= TAIL_PENDING_CAP;
  const wait = overCap ? 0 : penaltyMs;
  if (!overCap) tailPendingRejects++;
  setTimeout(() => {
    if (!overCap) tailPendingRejects--;
    try {
      socket.emit("device:tailRejected", { reason });
      socket.disconnect();
    } catch {}
    // Teardown that must outlive the answer (the PM behind an AgentBus session,
    // the device's other carriers) runs here, never before the client heard why.
    onClosed?.();
  }, wait);
}
