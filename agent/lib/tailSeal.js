// Sealing the key TAIL for the agent.
//
// The tail is the half of a v2 key that never reaches the Worker, and it is
// what admits a device. It travels in the connect handshake — fine over RTC,
// which is peer to peer, but the WS carrier is a Cloudflare tunnel, and whoever
// controls that path reads it off the wire.
//
// So the client encrypts to a key only the agent can decrypt with. One
// algorithm, X25519, over the platform's own crypto: an ephemeral keypair per
// sealing, ECDH against the agent's static key, HKDF to a symmetric key,
// AES-GCM to seal. The web side mirrors this in shared/transport/lib/tailSeal.js
// on WebCrypto; keep the two in step.
//
// What this does NOT do: prove which agent is on the other end. That is fp2's
// job — two characters read off the agent's screen, anchoring both host keys.
// Sealing to an unverified key still stops anyone listening on the path, but
// not a party that chose the key.
import crypto from "crypto";

// X25519 SPKI is a fixed 12-byte header plus the 32-byte key. The wire format
// is the raw key; both sides re-attach the header to import.
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e", "hex");
const RAW_KEY_BYTES = 32;
const IV_BYTES = 12;
const HKDF_INFO = "9remote-tail-seal-v1";

function importPublic(rawB64) {
  const raw = Buffer.from(String(rawB64), "base64");
  if (raw.length !== RAW_KEY_BYTES) return null;
  // Node's SPKI for X25519 is prefix || 0x03 0x21 0x00 || key.
  const spki = Buffer.concat([X25519_SPKI_PREFIX, Buffer.from([0x03, 0x21, 0x00]), raw]);
  try {
    return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

function deriveKey(sharedSecret, epkRaw, hostPubRaw) {
  // Both public keys go into the salt so a secret derived for one pair can never
  // be reused against another, even if the same ephemeral key were presented.
  const salt = Buffer.concat([epkRaw, hostPubRaw]);
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, salt, Buffer.from(HKDF_INFO), 32));
}

/**
 * Seal a tail for the agent holding hostX25519PubB64.
 * @returns {{epk: string, iv: string, ct: string}|null} null when either input is unusable
 */
export function sealTailFor(tail, hostX25519PubB64) {
  if (typeof tail !== "string" || !tail) return null;
  if (typeof hostX25519PubB64 !== "string" || !hostX25519PubB64) return null;
  const hostPub = importPublic(hostX25519PubB64);
  if (!hostPub) return null;

  try {
    const eph = crypto.generateKeyPairSync("x25519");
    const epkRaw = eph.publicKey.export({ type: "spki", format: "der" }).subarray(-RAW_KEY_BYTES);
    const hostPubRaw = hostPub.export({ type: "spki", format: "der" }).subarray(-RAW_KEY_BYTES);

    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: hostPub });
    const key = deriveKey(shared, epkRaw, hostPubRaw);

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(tail, "utf8"), cipher.final(), cipher.getAuthTag()]);

    return {
      epk: epkRaw.toString("base64"),
      iv: iv.toString("base64"),
      ct: ct.toString("base64")
    };
  } catch {
    return null;
  }
}

/**
 * Recover a sealed tail. Runs on whatever a public carrier delivered, so every
 * failure answers null rather than throwing.
 * @returns {string|null}
 */
export function unsealTail(sealed, hostX25519PrivKey) {
  if (!sealed || typeof sealed !== "object") return null;
  const { epk, iv, ct } = sealed;
  if (typeof epk !== "string" || typeof iv !== "string" || typeof ct !== "string") return null;

  const ephPub = importPublic(epk);
  if (!ephPub) return null;

  try {
    const ivBytes = Buffer.from(iv, "base64");
    const ctBytes = Buffer.from(ct, "base64");
    if (ivBytes.length !== IV_BYTES || ctBytes.length <= 16) return null;

    const epkRaw = ephPub.export({ type: "spki", format: "der" }).subarray(-RAW_KEY_BYTES);
    const hostPubRaw = crypto.createPublicKey(hostX25519PrivKey)
      .export({ type: "spki", format: "der" }).subarray(-RAW_KEY_BYTES);

    const shared = crypto.diffieHellman({ privateKey: hostX25519PrivKey, publicKey: ephPub });
    const key = deriveKey(shared, epkRaw, hostPubRaw);

    // Last 16 bytes are the GCM tag.
    const tag = ctBytes.subarray(ctBytes.length - 16);
    const body = ctBytes.subarray(0, ctBytes.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBytes);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, altered ciphertext, swapped ephemeral — all land here.
    return null;
  }
}

// fp2 — 2 chars of sha256 over BOTH host keys, on a 32-char alphabet (10 bits,
// no confusables, bias-free since 256 % 32 === 0). One fingerprint vouches for
// the signing key and the sealing key at once, so the user still reads two
// characters and both are anchored. Mirrored in web/shared/transport/lib.
const FP2_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function hostFp2Of(ed25519PubB64, x25519PubB64) {
  // Length-prefixed rather than concatenated: both are 32 bytes today, but a
  // bare join would let a future change move the boundary silently.
  const parts = [ed25519PubB64, x25519PubB64].map((k) => {
    const raw = Buffer.from(String(k || ""), "base64");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(raw.length);
    return Buffer.concat([len, raw]);
  });
  const digest = crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
  return FP2_ALPHABET[digest[0] % 32] + FP2_ALPHABET[digest[1] % 32];
}
