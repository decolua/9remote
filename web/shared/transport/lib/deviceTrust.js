// Device trust — client half of the E2E key security (see .docs/PLAN-e2e-key-security.md).
// Holds, per key HEAD: the pinned agent host key (verified via the pairing
// fp2) and the v2 key TAIL — typed as part of the key, or delivered inside the
// fp2-checked RTC channel at enroll time. Neither ever reaches the Worker; the
// TAIL travels only to the agent itself (see adapters/freshAuth).

import { CHANNELS, TAIL_REJECT_REASON, PENDING_SAVE_KEY, WANTS_SAVE_KEY } from "@/shared/constants/transport";
import { hostFp2Of } from "./tailSeal";

const TRUST_KEY = "9remote_device_trust";
const PENDING_FP2_KEY = "9remote_pending_fp2";
const ENROLL_RETRY_MS = 2500;
// Matches the one-time code TTL on the agent (10 minutes)
const PENDING_FP2_TTL_MS = 10 * 60 * 1000;

function readTrustMap() {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(TRUST_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeTrustMap(map) {
  if (typeof window === "undefined") return;
  localStorage.setItem(TRUST_KEY, JSON.stringify(map));
}

export function getTrust(apiKey) {
  return readTrustMap()[apiKey] || null;
}

/** Re-attach the stored TAIL to a HEAD-only key.
 *  A one-time login only ever receives the HEAD (the Worker holds nothing
 *  else), while the TAIL may already be in the trust store from an earlier
 *  enrollment. Saving the bare HEAD would leave the saved-keys entry unable to
 *  prove anything on a fresh browser profile. */
export function withTail(apiKey) {
  if (!apiKey) return apiKey;
  const tail = getTrust(apiKey)?.tail;
  return tail ? `${apiKey}-${tail}` : apiKey;
}

export function setTrust(apiKey, patch) {
  const map = readTrustMap();
  map[apiKey] = { ...(map[apiKey] || {}), ...patch };
  writeTrustMap(map);
}

/**
 * Pin the agent's host keys when they arrive from somewhere untrusted.
 *
 * A client that never established RTC never reached _verifyHostAnswer, so it
 * has nothing pinned and nothing to seal its tail to. /api/connect can hand the
 * keys over — but the Worker is precisely the party this design does not trust,
 * so they are only believed when fp2 over the pair matches the two characters
 * the user read off the agent's own screen.
 *
 * Returns true when the keys were pinned.
 */
/**
 * The fingerprint the agent prints on its pairing code: one value over both
 * host keys. An agent that presents no sealing key cannot produce it, and that
 * is the intended answer — v2 has not shipped, so there is no such agent to
 * stay compatible with, and accepting a single-key form would let a peer opt
 * out of being anchored for sealing simply by omitting the key.
 */
export async function hostFingerprint(edPubB64, xPubB64) {
  if (!edPubB64 || !xPubB64) return null;
  return await hostFp2Of(edPubB64, xPubB64);
}

export async function pinHostKeysWithFp2(apiKey, hostKeys) {
  // TEMP DIAGNOSTIC — sealing rollout; remove once verified end to end
  console.log("[seal] pin?", { hasEd: !!hostKeys?.ed, hasX: !!hostKeys?.x, pending: getPendingFp2() });
  if (!apiKey || !hostKeys?.ed || !hostKeys?.x) {
    console.log("[seal] pin SKIPPED — agent sent no sealing key (old agent?)");
    return false;
  }
  // Anchored already — unless the pin predates sealing, in which case it holds
  // a fingerprint from a scheme that no longer exists and would otherwise keep
  // the device from ever pairing again.
  const trust = getTrust(apiKey);
  if (trust?.hostPubKey && trust?.hostSealKey) {
    console.log("[seal] pin SKIPPED — already anchored");
    return false;
  }
  const pending = getPendingFp2();
  if (!pending) {
    console.log("[seal] pin SKIPPED — no pending fp2 (logged in without scanning a code)");
    return false;
  }
  const fp2 = await hostFingerprint(hostKeys.ed, hostKeys.x);
  if (fp2 !== pending) {
    console.log("[seal] pin REFUSED — fp2 mismatch", { computed: fp2, expected: pending });
    return false;
  }
  setTrust(apiKey, { hostPubKey: hostKeys.ed, hostSealKey: hostKeys.x, fp2 });
  console.log("[seal] pin OK — fp2", fp2, "sealing key stored");
  return true;
}

/** fp2 from the pairing code (URL fragment / typed suffix) — stays in the
 *  browser, one pairing attempt only, expiring with the code's own TTL so a
 *  stale fp2 can never reject a legitimate agent later in the same tab. */
export function setPendingFp2(fp2) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(PENDING_FP2_KEY, JSON.stringify({ fp2, exp: Date.now() + PENDING_FP2_TTL_MS }));
}

export function takePendingFp2() {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(PENDING_FP2_KEY);
  sessionStorage.removeItem(PENDING_FP2_KEY);
  return raw ? (JSON.parse(raw).fp2 ?? null) : null;
}

export function getPendingFp2() {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PENDING_FP2_KEY);
    if (!raw) return null;
    const { fp2, exp } = JSON.parse(raw);
    if (!fp2 || Date.now() > exp) {
      sessionStorage.removeItem(PENDING_FP2_KEY);
      return null;
    }
    return fp2;
  } catch {
    return null;
  }
}

// Saved-keys list (useApiKeyStorage) stores the key the user logs in with.
// After a one-time pairing that entry holds only the HEAD, so replace it with
// the full key once enrollment delivers the TAIL. Same storage shape as
// useApiKeyStorage — base64 per entry.
const SAVED_KEYS_STORAGE = "9remote_api_keys";

function upgradeSavedKey(headKey, fullKey) {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(SAVED_KEYS_STORAGE);
    if (!raw) return;
    const list = JSON.parse(raw);
    let changed = false;
    const next = list.map((item) => {
      if (atob(item.key) !== headKey) return item;
      changed = true;
      return { ...item, key: btoa(fullKey) };
    });
    if (changed) localStorage.setItem(SAVED_KEYS_STORAGE, JSON.stringify(next));
  } catch {
    // Corrupt/unavailable storage — the user can re-enter the key; not fatal
  }
}

/**
 * Commit the key the user asked to remember, now that the agent has accepted
 * it. Called on device:approved — the first moment anything has actually
 * checked the TAIL.
 *
 * Nothing is deleted on refusal, deliberately: a key that was never saved needs
 * no undo, and deleting on the way out once cost users a GOOD stored key when a
 * mistyped tail happened to share its HEAD.
 */
export function commitPendingKey() {
  if (typeof window === "undefined") return;
  try {
    const pending = sessionStorage.getItem(PENDING_SAVE_KEY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_SAVE_KEY);

    const list = JSON.parse(localStorage.getItem(SAVED_KEYS_STORAGE) || "[]");
    // Already stored (a re-login with the same key) — nothing to add.
    if (list.some((item) => { try { return atob(item.key) === pending; } catch { return false; } })) return;
    list.push({
      id: String(Date.now()),
      key: btoa(pending),
      label: `Key ${list.length + 1}`,
      createdAt: new Date().toISOString(),
      lastLoginDate: new Date().toISOString()
    });
    localStorage.setItem(SAVED_KEYS_STORAGE, JSON.stringify(list));
  } catch {
    // Corrupt/unavailable storage — the user can re-enter the key; not fatal
  }
}

/** Drop a TAIL the agent refused. The saved-keys list is untouched: a rejected
 *  key was never committed there, and a key that WAS committed is one the agent
 *  accepted before — not something a failed attempt should remove. */
export function forgetRejectedTail(apiKey) {
  if (typeof window === "undefined" || !apiKey) return;
  try {
    const map = readTrustMap();
    delete map[apiKey];
    writeTrustMap(map);
  } catch {
    // Storage unavailable — the next login overwrites the entry anyway
  }
}

// ── Crypto helpers (WebCrypto) ────────────────────────────────────────────────

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Ed25519 signature check; resolves null when the browser lacks Ed25519
 *  support (caller falls back to comparing fp2). */
export async function verifySdpSignature(publicKeyB64, sdp, sigB64) {
  try {
    const key = await crypto.subtle.importKey("raw", b64ToBytes(publicKeyB64), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, b64ToBytes(sigB64), new TextEncoder().encode(sdp));
  } catch {
    return null;
  }
}

// The TAIL itself travels in the handshake (see adapters/freshAuth) — the
// carriers are the user's own tunnel and the RTC channel, not this project's
// server — so no HMAC proof is derived from it here.

// ── PM integration — control-channel events both directions ──────────────────

// Registered on the PM's ClientBus (web ProtocolManager constructor): every
// carrier's dispatch ends at that one bus, so a single registration covers both —
// WS and RTC alike land in handleDeviceAuthEvent with the unpacked payload as the
// first arg.
export const DEVICE_AUTH_EVENTS = ["device:keyIssued", "device:tailRejected"];

/** Handle a device-auth control event. Returns true when consumed. */
export function handleDeviceAuthEvent(pm, event, data) {
  const apiKey = pm._auth?.apiKey;
  if (!apiKey) return false;
  if (event === "device:keyIssued") {
    // A one-time code got this device in, but the code dies in minutes. The
    // agent hands over the API key's own TAIL so the device can prove itself
    // from now on — this is the moment a pairing turns into a lasting login,
    // and the only moment the full key exists in the browser.
    const tail = data?.tail;
    if (!tail) return true;
    setTrust(apiKey, { tail });
    // Already proven for this peer: the agent settled it when it issued the key.
    pm._tailProofSent = pm._adapters.get("rtc")?._peerEpoch ?? 0;
    // Saved only if the user asked to remember. commitPendingKey stores what
    // was parked at login; a pairing parks nothing, so the full key is parked
    // here instead — after acceptance, which is the rule for every key.
    if (typeof window !== "undefined" && sessionStorage.getItem(WANTS_SAVE_KEY)) {
      sessionStorage.removeItem(WANTS_SAVE_KEY);
      sessionStorage.setItem(PENDING_SAVE_KEY, `${apiKey}-${tail}`);
      commitPendingKey();
    }
    return true;
  }
  if (event === "device:tailRejected") {
    // A stale seal pin (the agent rotated its host key) is recoverable: drop the
    // pin and the reconnect proves with a plain tail. A plain mismatch is final,
    // and useSocket takes it from there — back to login, key forgotten.
    if (data?.reason === TAIL_REJECT_REASON.sealUnreadable) setTrust(apiKey, { hostSealKey: null });
    return true;
  }
  return false;
}

/**
 * Prove the key TAIL over an open RTC channel.
 *
 * The tail normally rides the WS handshake, but an RTC-first session has no
 * handshake at all — the agent holds such a session on a deadline and drops it
 * unless this arrives. Sent DIRECTLY through the RTC adapter (peer to peer):
 * pm.emit's control bus can fall back to WS, and the tunnel is exactly the path
 * sealing exists to keep the tail off.
 *
 * Same {keyTail|keyTailSealed} shape as the handshake, so the agent has one
 * parser for both. Once per PEER, not per PM: the agent keeps its verdict in
 * RAM, so a restart (which produces a new peer) needs the proof again, while
 * the RTC retry loop reopening the same peer's channel must not re-prove.
 */
export async function maybeSendTailProof(pm) {
  const apiKey = pm._auth?.apiKey;
  if (!apiKey) return;
  const rtc = pm._adapters.get("rtc");
  if (!rtc?.ready) return;
  const peerMark = rtc._peerEpoch ?? 0;
  if (pm._tailProofSent === peerMark) return;
  const { freshAuth } = await import("../adapters/freshAuth");
  // tempKey included so freshAuth can find a CODE's tail, which is filed under
  // the code rather than the key's HEAD.
  const auth = await freshAuth({ apiKey, tempKey: pm._auth?.tempKey || null }, "rtc");
  if (!auth.keyTail && !auth.keyTailSealed) return; // v1 key, or no tail held
  // The tempKey rides along because this carrier has no handshake to hold it:
  // a pairing device proves against the CODE's tail, and without knowing that,
  // the agent compares it to the API key's and refuses a code that was right.
  const sent = rtc.send(CHANNELS.control, {
    event: "device:tailProof",
    args: [{ keyTail: auth.keyTail, keyTailSealed: auth.keyTailSealed, tempKey: pm._auth?.tempKey || null }]
  });
  if (sent) pm._tailProofSent = peerMark;
}

