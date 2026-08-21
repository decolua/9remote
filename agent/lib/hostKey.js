// Host key — Ed25519 identity of this agent machine. Signs SDP answers so the
// client can verify the signaling relay never swapped the peer on it.
import crypto from "crypto";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { writeJsonAtomic } from "./atomicFile.js";
import { join } from "path";
import { PATHS } from "./constants.js";

const HOST_KEY_FILE = join(PATHS.CONFIG, "hostKey.json");

// Ed25519 SPKI is a fixed 12-byte header + the 32-byte raw key. The wire format
// ("pub" in signaling answers) is the RAW key — WebCrypto importKey("raw") for
// Ed25519 requires exactly 32 bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// fp2 — 2 chars of sha256(public key raw) mapped onto a 32-char alphabet
// (10 bits, no confusables, bias-free: 256 % 32 === 0). Must mirror the web
// side (web/shared/transport/lib/deviceTrust.js fp2OfPublicKey).
const FP2_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function fp2OfPublicKey(publicKeyB64) {
  const raw = Buffer.from(publicKeyB64, "base64");
  const digest = crypto.createHash("sha256").update(raw).digest();
  return FP2_ALPHABET[digest[0] % 32] + FP2_ALPHABET[digest[1] % 32];
}

let _cached = null;

function load() {
  if (_cached) return _cached;
  try {
    if (existsSync(HOST_KEY_FILE)) {
      const data = JSON.parse(readFileSync(HOST_KEY_FILE, "utf8"));
      const spki = Buffer.from(data.publicKey, "base64");
      _cached = {
        privateKey: crypto.createPrivateKey({ key: Buffer.from(data.privateKey, "base64"), format: "der", type: "pkcs8" }),
        publicKey: crypto.createPublicKey({ key: spki, format: "der", type: "spki" }),
        publicKeyB64: spki.subarray(-32).toString("base64")
      };
      return _cached;
    }
  } catch {
    // Corrupt file — fall through and regenerate
  }
  mkdirSync(PATHS.CONFIG, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const spkiB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateKeyB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  writeJsonAtomic(HOST_KEY_FILE, { privateKey: privateKeyB64, publicKey: spkiB64 });
  _cached = { privateKey, publicKey, publicKeyB64: Buffer.from(spkiB64, "base64").subarray(-32).toString("base64") };
  return _cached;
}

export function getHostKey() {
  return load();
}

export function getHostPublicKeyB64() {
  return load().publicKeyB64;
}

// 2-char fingerprint of this agent's host key — rides the one-time pairing code.
export function getHostFp2() {
  return fp2OfPublicKey(load().publicKeyB64);
}

export function signSdp(sdp) {
  const sig = crypto.sign(null, Buffer.from(sdp, "utf8"), load().privateKey);
  return sig.toString("base64");
}

export function verifySig(publicKeyB64, message, sigB64) {
  try {
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64, "base64")]);
    const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}
