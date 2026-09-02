// Client half of tail sealing — mirror of agent/lib/tailSeal.js.
//
// The key TAIL is what admits a device to the agent, and it goes in the connect
// handshake. Over RTC that is peer to peer; over the WS carrier it is a
// Cloudflare tunnel, and whoever controls that path reads it. Encrypting to the
// agent's X25519 key closes that path without moving the tail anywhere new.
//
// Every constant here has a counterpart on the agent — the HKDF info string,
// the salt, the IV size, the tag appended to the ciphertext. Change one and the
// other side stops decrypting; web/test/tailSealInterop.test.mjs runs both
// implementations against each other for exactly that reason.

const RAW_KEY_BYTES = 32;
const IV_BYTES = 12;
const HKDF_INFO = "9remote-tail-seal-v1";
// X25519 SPKI: fixed header, then 0x03 0x21 0x00, then the raw key.
const X25519_SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function importPublic(rawB64) {
  let raw;
  try {
    raw = b64ToBytes(String(rawB64));
  } catch {
    return null;
  }
  if (raw.length !== RAW_KEY_BYTES) return null;
  try {
    return await crypto.subtle.importKey("spki", concat(X25519_SPKI_PREFIX, raw), { name: "X25519" }, true, []);
  } catch {
    return null;
  }
}

async function deriveKey(privateKey, publicKey, epkRaw, hostPubRaw) {
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // Both public keys, so a secret derived for one pair cannot be reused
      // against another.
      salt: concat(epkRaw, hostPubRaw),
      info: new TextEncoder().encode(HKDF_INFO)
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
}

/**
 * Seal a tail for the agent holding hostX25519PubB64.
 * @returns {Promise<{epk: string, iv: string, ct: string}|null>} null when either input is unusable
 */
export async function sealTail(tail, hostX25519PubB64) {
  if (typeof tail !== "string" || !tail) return null;
  if (typeof hostX25519PubB64 !== "string" || !hostX25519PubB64) return null;

  const hostPub = await importPublic(hostX25519PubB64);
  if (!hostPub) return null;

  try {
    const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const epkRaw = new Uint8Array(await crypto.subtle.exportKey("spki", eph.publicKey)).slice(-RAW_KEY_BYTES);
    const hostPubRaw = new Uint8Array(await crypto.subtle.exportKey("spki", hostPub)).slice(-RAW_KEY_BYTES);

    const key = await deriveKey(eph.privateKey, hostPub, epkRaw, hostPubRaw);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    // WebCrypto appends the GCM tag to the ciphertext, which is the layout the
    // agent expects — it takes the last 16 bytes as the tag.
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(tail));

    return { epk: bytesToB64(epkRaw), iv: bytesToB64(iv), ct: bytesToB64(ct) };
  } catch {
    // No X25519 in this browser, or storage/crypto unavailable. The caller falls
    // back to sending the tail as before rather than failing the connection.
    return null;
  }
}

// fp2 — 2 chars of sha256 over BOTH host keys, on a 32-char alphabet (10 bits,
// no confusables, bias-free since 256 % 32 === 0). One fingerprint anchors the
// signing key and the sealing key together, so the user still reads two
// characters off the agent's screen and both are covered.
const FP2_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function hostFp2Of(ed25519PubB64, x25519PubB64) {
  // Insecure context (crypto.subtle gone) — null tells the caller "cannot
  // verify", same contract as sealTail's fallback, instead of blowing up
  // mid-signal (see WebRtcProtocol _handleSignal's catch).
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  // Length-prefixed, so the boundary between the two keys cannot shift.
  const parts = [ed25519PubB64, x25519PubB64].map((k) => {
    let raw;
    try {
      raw = b64ToBytes(String(k || ""));
    } catch {
      raw = new Uint8Array(0);
    }
    const len = new Uint8Array(2);
    new DataView(len.buffer).setUint16(0, raw.length);
    return concat(len, raw);
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(...parts)));
  return FP2_ALPHABET[digest[0] % 32] + FP2_ALPHABET[digest[1] % 32];
}
