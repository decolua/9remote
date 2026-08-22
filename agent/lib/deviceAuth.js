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
import { validatePairingFp2, getActivePairing } from "./pairingCode.js";
import { CHANNELS } from "./transportConstants.js";
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
 * Single admission decision for a connecting device — one place instead of the
 * same proof/grandfather/auto-approve reasoning repeated per carrier.
 *
 * Returns one of:
 *   "admit"   — let it in silently (and mark the TAIL proven when it proved)
 *   "hold"    — needs host approval (modal / Clients list)
 *   "reject"  — previously rejected device
 */
export function decideAdmission(socket, deviceId) {
  const gate = gateDevice(deviceId);
  if (gate === "rejected") return "reject";

  // Redeemed a live one-time code. This stands in for the TAIL proof — the user
  // read the code off the agent's own screen, which is an out-of-band claim the
  // TAIL cannot make — but it does NOT stand in for the host's approval. With
  // auto-approve off, an unknown device still waits in the modal; the code only
  // spares it from being asked for a TAIL it has no way to hold yet.
  // The tempKey is client-supplied, so it must match the code actually on
  // screen — not merely "some code is live".
  const presentedTemp = String(socket.handshake?.auth?.tempKey || "").toUpperCase();
  const paired = !!deviceId && !!presentedTemp
    && presentedTemp === getActivePairing()?.tempKey
    && !isDeviceKicked(deviceId);
  if (paired && (gate === "approved" || gate === "auto")) {
    approveDevice(deviceId);
    logger.info(`device paired via one-time code: ${deviceId.slice(0, 8)}...`);
    return "admit";
  }

  if (gate !== "approved" && gate !== "auto") return "hold";

  // v1 key (no split): nothing to prove — behave exactly as before the split.
  if (!isTailProofEnabled()) return "admit";

  // Sealed when the client could reach our X25519 key, plain over RTC. Resolved
  // once — opening a seal is an ECDH and a decrypt, and the branch below asks
  // the same question.
  const presented = presentedTailOf(socket.handshake?.auth, openSealedTail);

  // An RTC-only session (VirtualSocket, offer arrived before the tunnel) has no
  // socket.io handshake, so it carries no TAIL — the client sends it with the
  // WS connect that follows. Demanding it here would drop a session the gate
  // already admitted and bounce the device back into the approval modal, even
  // with auto-approve on. The WS carrier still presents it when it attaches.
  if (socket.isVirtual && presented === undefined) {
    if (gate === "auto") approveDevice(deviceId);
    return "admit";
  }

  const keyHead = headOf(loadKey()?.key || "");

  // An enrollment that already ran on this socket counts too — the TAIL reached
  // that device through the fp2-checked RTC channel.
  if (socket.data?.provenDevice === true || verifyKeyTail(presented)) {
    socket.data.provenDevice = true;
    if (gate === "auto") approveDevice(deviceId); // create the entry first
    markTailProven(deviceId, keyHead);
    return "admit";
  }

  // A TAIL was presented and it does NOT match: an impostor, or a client still
  // holding the TAIL of a regenerated key. Never admit — no grandfathering.
  if (presented) return "hold";

  // No TAIL at all. Not an attack signal by itself: a pre-split client, a v1
  // pairing, or a device whose TAIL was retired when the key was regenerated —
  // none of them can produce a TAIL that no longer exists. Only demand one from
  // a device that presented it against THIS key before (its client clearly can).
  if (gate === "approved" && !hasProvenTail(deviceId, keyHead)) return "admit";
  return "hold";
}

/**
 * Pairing enrollment — client presents the fp2 it read off the pairing code.
 * Valid only while a pairing code is live; wrong fp2 burns an attempt and 3
 * misses kill the code. Delivers the key TAIL DIRECTLY through the RTC
 * adapter — never socket.emit / the PM control bus, whose WS fallback would
 * leak it through the tunnel.
 */
export function handleDeviceEnroll(socket, data) {
  const deviceId = socket.handshake?.auth?.deviceId || socket.deviceId || null;
  if (!deviceId) return;

  if (!getActivePairing() || !validatePairingFp2(String(data?.fp2 || ""))) {
    // The code this device paired with is now dead (wrong fp2 burns it), so the
    // session it bought is no longer legitimate either — revoke the approval it
    // just got and drop the socket. Leaving it connected would mean a bad fp2
    // costs the presenter nothing but the TAIL.
    socket.emit("device:enrollRejected");
    if (!hasProvenTail(deviceId, headOf(loadKey()?.key || ""))) {
      removeDevice(deviceId);
      logger.warn(`enrollment rejected — revoking ${deviceId.slice(0, 8)}... and closing`);
      try { socket.disconnect(); } catch {}
    }
    return;
  }
  const tail = agentTail();
  if (!tail) {
    socket.emit("device:enrollRejected"); // v1 key — nothing to deliver
    return;
  }
  const rtc = socket.data?.protocol?._adapters.get("rtc");
  if (rtc?.ready !== true) {
    // WS-only carrier — the TAIL must not transit the tunnel. Nothing is
    // marked proven; the client retries on a connection where RTC is up.
    socket.emit("device:enrollRetry");
    return;
  }
  approveDevice(deviceId);
  logger.info(`device enrolled: ${deviceId.slice(0, 8)}...`);
  const sent = rtc.send(CHANNELS.control, { event: "device:enrolled", args: [{ tail }] });
  if (sent) {
    socket.data.provenDevice = true; // settles an in-flight proof
    // The device now holds THIS key's TAIL — from here it must prove with it.
    markTailProven(deviceId, headOf(loadKey()?.key || ""));
  } else {
    socket.emit("device:enrollRetry"); // DC died mid-send — retry re-delivers
  }
}
