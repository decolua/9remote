// Device trust: pins host key and stores key tail per HEAD for E2E security.

import { CHANNELS, TAIL_REJECT_REASON, PENDING_SAVE_KEY, WANTS_SAVE_KEY, KEYS_CHANGED_EVENT } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";
import { hostFp2Of } from "./tailSeal";

const TRUST_KEY = "9remote_device_trust";
const PENDING_FP2_KEY = "9remote_pending_fp2";
const ENROLL_RETRY_MS = 2500;
// Matches the one-time code TTL on the host (10 minutes)
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

// Re-attaches stored TAIL to a HEAD-only key.
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

// Computes pairing fingerprint over both host keys (Ed25519 and X25519).
export async function hostFingerprint(edPubB64, xPubB64) {
  if (!edPubB64 || !xPubB64) return null;
  return await hostFp2Of(edPubB64, xPubB64);
}

// Pins host keys only when fp2 matches the two characters verified by the user.
export async function pinHostKeysWithFp2(apiKey, hostKeys) {
  debugLog("auth", "[seal] pin?", { hasEd: !!hostKeys?.ed, hasX: !!hostKeys?.x, pending: getPendingFp2() });
  if (!apiKey || !hostKeys?.ed || !hostKeys?.x) {
    debugLog("auth", "[seal] pin SKIPPED — host sent no sealing key (old host?)");
    return false;
  }
  // Skip if already anchored with both host keys.
  const trust = getTrust(apiKey);
  if (trust?.hostPubKey && trust?.hostSealKey) {
    debugLog("auth", "[seal] pin SKIPPED — already anchored");
    return false;
  }
  const pending = getPendingFp2();
  if (!pending) {
    debugLog("auth", "[seal] pin SKIPPED — no pending fp2 (logged in without scanning a code)");
    return false;
  }
  const fp2 = await hostFingerprint(hostKeys.ed, hostKeys.x);
  if (fp2 !== pending) {
    debugLog("auth", "[seal] pin REFUSED — fp2 mismatch", { computed: fp2, expected: pending });
    return false;
  }
  setTrust(apiKey, { hostPubKey: hostKeys.ed, hostSealKey: hostKeys.x, fp2 });
  debugLog("auth", "[seal] pin OK — fp2", fp2, "sealing key stored");
  return true;
}

// Ephemeral fp2 from pairing code with TTL matching host code expiration.
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

// Upgrades a saved key from HEAD to HEAD-TAIL after enrollment.
const SAVED_KEYS_STORAGE = "9remote_api_keys";

// Saved-key writes here bypass useApiKeyStorage — same announcement, or the
// workspace layout's fleet sync never hears about them.
const notifyKeysChanged = () => {
  try { window.dispatchEvent(new Event(KEYS_CHANGED_EVENT)); } catch {}
};

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
    if (changed) {
      localStorage.setItem(SAVED_KEYS_STORAGE, JSON.stringify(next));
      notifyKeysChanged();
    }
  } catch {}
}

// Commits pending key to storage once host approves device.
export function commitPendingKey() {
  if (typeof window === "undefined") return;
  try {
    const pending = sessionStorage.getItem(PENDING_SAVE_KEY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_SAVE_KEY);

    const list = JSON.parse(localStorage.getItem(SAVED_KEYS_STORAGE) || "[]");
    if (list.some((item) => { try { return atob(item.key) === pending; } catch { return false; } })) return;
    list.push({
      id: String(Date.now()),
      key: btoa(pending),
      label: `Key ${list.length + 1}`,
      createdAt: new Date().toISOString(),
      lastLoginDate: new Date().toISOString()
    });
    localStorage.setItem(SAVED_KEYS_STORAGE, JSON.stringify(list));
    notifyKeysChanged();
  } catch {}
}

// Drops rejected TAIL from trust store without altering saved keys.
export function forgetRejectedTail(apiKey) {
  if (typeof window === "undefined" || !apiKey) return;
  try {
    const map = readTrustMap();
    delete map[apiKey];
    writeTrustMap(map);
  } catch {}
}

// ── Crypto helpers (WebCrypto) ────────────────────────────────────────────────

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Ed25519 signature check; resolves null when browser lacks Ed25519 support.
export async function verifySdpSignature(publicKeyB64, sdp, sigB64) {
  try {
    const key = await crypto.subtle.importKey("raw", b64ToBytes(publicKeyB64), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, b64ToBytes(sigB64), new TextEncoder().encode(sdp));
  } catch {
    return null;
  }
}

// ── PM integration — control-channel events both directions ──────────────────

// Handles device-auth events across WS and RTC carriers.
export const DEVICE_AUTH_EVENTS = ["device:keyIssued", "device:tailRejected"];

export function handleDeviceAuthEvent(pm, event, data) {
  const apiKey = pm._auth?.apiKey;
  if (!apiKey) return false;
  if (event === "device:keyIssued") {
    // Pairing complete: every later proof (WS reconnect, RTC re-offer) must
    // present the KEY tail WITHOUT the one-time key — while tempKey is still
    // attached the host validates against the RANDOM pairing tail instead,
    // and the mismatch kills the code and drops the socket. Clear it from
    // this PM's auth, handshake included.
    pm._auth.tempKey = null;
    if (pm._auth.socketOptions?.auth) pm._auth.socketOptions.auth.tempKey = null;
    // And from the session store, or the next page load resurrects it: getAuth
    // would rebuild the wire with the code attached, the host (its pairing
    // window still live) would judge the KEY tail against the CODE tail, and
    // the mismatch burns the code and kicks the user out — with the key itself
    // safely saved, which is exactly as confusing as it sounds.
    try { sessionStorage.removeItem("tempKey"); } catch {}
    // Store issued TAIL to establish persistent device authentication.
    const tail = data?.tail;
    if (!tail) return true;
    setTrust(apiKey, { tail });
    pm._tailProofSent = pm._adapters.get("rtc")?._peerEpoch ?? 0;
    // Save full key to storage if user requested persistence during pairing.
    if (typeof window !== "undefined" && sessionStorage.getItem(WANTS_SAVE_KEY)) {
      sessionStorage.removeItem(WANTS_SAVE_KEY);
      sessionStorage.setItem(PENDING_SAVE_KEY, `${apiKey}-${tail}`);
      commitPendingKey();
    }
    return true;
  }
  if (event === "device:tailRejected") {
    // Reset hostSealKey on unreadable seal so reconnect can fallback to plain tail.
    if (data?.reason === TAIL_REJECT_REASON.sealUnreadable) setTrust(apiKey, { hostSealKey: null });
    return true;
  }
  return false;
}

// Prove key TAIL directly over RTC channel for RTC-first sessions without WS handshake.
export async function maybeSendTailProof(pm) {
  const apiKey = pm._auth?.apiKey;
  if (!apiKey) return;
  const rtc = pm._adapters.get("rtc");
  if (!rtc?.ready) return;
  const peerMark = rtc._peerEpoch ?? 0;
  if (pm._tailProofSent === peerMark) return;
  const { freshAuth } = await import("../adapters/freshAuth");
  const auth = await freshAuth({ apiKey, tempKey: pm._auth?.tempKey || null }, "rtc");
  if (!auth.keyTail && !auth.keyTailSealed) return; // v1 key, or no tail held
  // Pass tempKey so host validates against pairing code tail instead of API key tail.
  const sent = rtc.send(CHANNELS.control, {
    event: "device:tailProof",
    args: [{ keyTail: auth.keyTail, keyTailSealed: auth.keyTailSealed, tempKey: pm._auth?.tempKey || null }]
  });
  if (sent) pm._tailProofSent = peerMark;
}

