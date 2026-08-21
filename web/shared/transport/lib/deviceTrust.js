// Device trust — client half of the E2E key security (see .docs/PLAN-e2e-key-security.md).
// Holds, per key HEAD: the pinned agent host key (verified via the pairing
// fp2) and the v2 key TAIL (typed as part of the key, or delivered inside the
// fp2-checked RTC channel at enroll time — never through the Worker). Also
// answers agent auth challenges.

import { CHANNELS } from "@/shared/constants/transport";

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

// ── Crypto helpers (WebCrypto) ────────────────────────────────────────────────

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Mirror of agent lib/hostKey.js — 2 chars of sha256(pub) over a 32-char
// alphabet (10 bits, bias-free: 256 % 32 === 0, no confusables).
const FP2_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function fp2OfPublicKey(publicKeyB64) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", b64ToBytes(publicKeyB64)));
  return FP2_ALPHABET[digest[0] % 32] + FP2_ALPHABET[digest[1] % 32];
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

/** HMAC-SHA256(secret, message) → base64 — the device proof. */
export async function deviceProof(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToB64(new Uint8Array(mac));
}

/**
 * Proof carried in the socket.io handshake, so admission needs no extra
 * round-trip (and no timeout waiting for one). The agent replays the same
 * message and compares; a client-chosen nonce plus a timestamp window makes
 * a captured proof useless later (see agent lib/deviceAuth verifyHandshakeProof).
 * Returns null when this device holds no TAIL — the agent then applies its
 * legacy/grandfather path.
 */
export async function buildHandshakeProof(apiKey, deviceId) {
  const tail = getTrust(apiKey)?.tail;
  if (!tail || !deviceId) return null;
  try {
    const ts = Date.now();
    const nonce = bytesToB64(crypto.getRandomValues(new Uint8Array(12)));
    const mac = await deviceProof(tail, `${ts}.${nonce}.${deviceId}`);
    return { ts, nonce, mac };
  } catch {
    return null; // no WebCrypto (insecure context) — fall back to legacy path
  }
}

// ── PM integration — control-channel events both directions ──────────────────

// Registered on the PM proxy socket (web ProtocolManager constructor): WS fires
// these natively on the raw socket, RTC dispatch reaches them via the proxy
// listener map — both carriers land in handleDeviceAuthEvent with the unpacked
// payload as the first arg.
export const DEVICE_AUTH_EVENTS = ["device:enrolled", "device:enrollRejected", "device:enrollRetry"];

/** Handle a device-auth control event. Returns true when consumed. */
export function handleDeviceAuthEvent(pm, event, data) {
  const apiKey = pm._auth?.apiKey;
  if (!apiKey) return false;
  if (event === "device:enrolled") {
    setTrust(apiKey, { tail: data?.tail || null });
    takePendingFp2(); // pairing complete
    // The saved-keys entry was written at login time, before the TAIL existed
    // (a one-time login only ever receives the HEAD). Upgrade it now so the
    // next login from the saved list can still answer the agent's challenge.
    if (data?.tail) upgradeSavedKey(apiKey, `${apiKey}-${data.tail}`);
    return true;
  }
  if (event === "device:enrollRejected") {
    takePendingFp2(); // stop retrying — the user re-pairs with a fresh code
    return true;
  }
  if (event === "device:enrollRetry") {
    // RTC wasn't the agent's control carrier at that instant (its DC may open a
    // beat after ours) — no new "open" event will fire, so retry on a timer.
    setTimeout(() => maybeSendEnroll(pm), ENROLL_RETRY_MS);
    return true;
  }
  return false;
}

/** Send the enrollment request once the RTC carrier is open and a pairing
 *  fp2 is still pending. Sent DIRECTLY through the RTC adapter — the fp2 must
 *  never transit the tunnel (pm.emit's control bus can fall back to WS). */
export function maybeSendEnroll(pm) {
  const apiKey = pm._auth?.apiKey;
  const deviceId = pm._auth?.deviceId;
  if (!apiKey || !deviceId) return;
  const fp2 = getPendingFp2();
  if (!fp2) return;
  if (getTrust(apiKey)?.tail) { takePendingFp2(); return; }
  const rtc = pm._adapters.get("rtc");
  if (!rtc?.ready) return; // wait for the DTLS channel
  rtc.send(CHANNELS.control, { event: "device:enroll", args: [{ deviceId, fp2 }] });
}
