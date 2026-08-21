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

const logger = createLogger("deviceAuth");

function agentTail() {
  return tailOf(loadKey()?.key || "");
}

export function isTailProofEnabled() {
  return !!agentTail();
}

function hmacB64(secret, message) {
  return crypto.createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(message, "utf8"))
    .digest("base64");
}

function macMatches(message, mac) {
  const tail = agentTail();
  if (!tail || !mac) return false;
  const a = Buffer.from(mac);
  const b = Buffer.from(hmacB64(tail, message));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Replay guard for handshake proofs. The client picks the nonce, so a captured
// proof must not be reusable: it expires with the timestamp window, and each
// nonce is accepted exactly once inside that window.
const PROOF_WINDOW_MS = 2 * 60 * 1000;
const seenNonces = new Map(); // nonce -> expiry

function nonceUsed(nonce) {
  const now = Date.now();
  if (seenNonces.size > 4096) {
    for (const [n, exp] of seenNonces) if (exp <= now) seenNonces.delete(n);
  }
  const exp = seenNonces.get(nonce);
  if (exp && exp > now) return true;
  seenNonces.set(nonce, now + PROOF_WINDOW_MS);
  return false;
}

/**
 * Verify the proof carried in the socket.io handshake — no round-trip, so
 * admission is decided the moment a socket connects.
 * @param {{ts:number, nonce:string, mac:string}} proof
 */
export function verifyHandshakeProof(proof, deviceId) {
  if (!proof?.mac || !proof?.nonce || !Number.isFinite(proof.ts) || !deviceId) return false;
  if (Math.abs(Date.now() - proof.ts) > PROOF_WINDOW_MS) return false;
  if (!macMatches(`${proof.ts}.${proof.nonce}.${deviceId}`, proof.mac)) return false;
  // Signature is valid — only now spend a nonce slot (an invalid proof must not
  // let an attacker burn nonces a legitimate client might pick).
  return !nonceUsed(proof.nonce);
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

  // An RTC-only session (VirtualSocket, offer arrived before the tunnel) has no
  // socket.io handshake, so it carries no proof — the client sends it with the
  // WS connect that follows. Demanding proof here would drop a session the gate
  // already admitted and bounce the device back into the approval modal, even
  // with auto-approve on. The WS carrier still proves when it attaches.
  if (socket.isVirtual && !socket.handshake?.auth?.proof) {
    if (gate === "auto") approveDevice(deviceId);
    return "admit";
  }

  // The proof rides the handshake, so this needs no round-trip. An enrollment
  // that already ran on this socket counts too (the TAIL only ever reached the
  // device through the fp2-checked RTC channel).
  const keyHead = headOf(loadKey()?.key || "");
  const presented = socket.handshake?.auth?.proof;

  if (socket.data?.provenDevice === true || verifyHandshakeProof(presented, deviceId)) {
    socket.data.provenDevice = true;
    if (gate === "auto") approveDevice(deviceId); // create the entry first
    markTailProven(deviceId, keyHead);
    return "admit";
  }

  // A proof was presented and it did NOT verify: this is an impostor (or a
  // client holding a retired TAIL). Never admit — no grandfathering here.
  if (presented) return "hold";

  // No proof at all. Not an attack signal by itself: a pre-split client, a v1
  // pairing, or a device whose TAIL was retired when the key was regenerated —
  // none of them can produce a TAIL that no longer exists. Only demand one from
  // a device that proved against THIS key before (its client clearly can).
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
