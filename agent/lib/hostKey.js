// Host key — Ed25519 identity of this agent machine. Signs SDP answers so the
// client can verify the signaling relay never swapped the peer on it.
import crypto from "crypto";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { writeJsonAtomic } from "./atomicFile.js";
import { join } from "path";
import { PATHS } from "./constants.js";
import { unsealTail } from "./tailSeal.js";

const HOST_KEY_FILE = join(PATHS.CONFIG, "hostKey.json");

// Ed25519 SPKI is a fixed 12-byte header + the 32-byte raw key. The wire format
// ("pub" in signaling answers) is the RAW key — WebCrypto importKey("raw") for
// Ed25519 requires exactly 32 bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

let _cached = null;

function load() {
  if (_cached) return _cached;
  try {
    if (existsSync(HOST_KEY_FILE)) {
      const data = JSON.parse(readFileSync(HOST_KEY_FILE, "utf8"));
      const spki = Buffer.from(data.publicKey, "base64");
      // A file written before sealing existed has no X25519 half; generate one
      // and write it back rather than discarding the Ed25519 identity, which
      // clients may already have pinned.
      if (!data.x25519PrivateKey) {
        const x = crypto.generateKeyPairSync("x25519");
        data.x25519PrivateKey = x.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
        data.x25519PublicKey = x.publicKey.export({ type: "spki", format: "der" }).toString("base64");
        writeJsonAtomic(HOST_KEY_FILE, data);
      }
      const xSpki = Buffer.from(data.x25519PublicKey, "base64");
      _cached = {
        privateKey: crypto.createPrivateKey({ key: Buffer.from(data.privateKey, "base64"), format: "der", type: "pkcs8" }),
        publicKey: crypto.createPublicKey({ key: spki, format: "der", type: "spki" }),
        publicKeyB64: spki.subarray(-32).toString("base64"),
        x25519PrivateKey: crypto.createPrivateKey({ key: Buffer.from(data.x25519PrivateKey, "base64"), format: "der", type: "pkcs8" }),
        x25519PublicKeyB64: xSpki.subarray(-32).toString("base64")
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
  // Ed25519 signs, X25519 receives — one algorithm cannot do both, and fp2
  // covers the pair so the user still reads two characters for both.
  const x = crypto.generateKeyPairSync("x25519");
  const xSpkiB64 = x.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  writeJsonAtomic(HOST_KEY_FILE, {
    privateKey: privateKeyB64,
    publicKey: spkiB64,
    x25519PrivateKey: x.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    x25519PublicKey: xSpkiB64
  });
  _cached = {
    privateKey, publicKey,
    publicKeyB64: Buffer.from(spkiB64, "base64").subarray(-32).toString("base64"),
    x25519PrivateKey: x.privateKey,
    x25519PublicKeyB64: Buffer.from(xSpkiB64, "base64").subarray(-32).toString("base64")
  };
  return _cached;
}

export function getHostKey() {
  return load();
}

export function getHostPublicKeyB64() {
  return load().publicKeyB64;
}

/** The key clients seal the TAIL to. Public half only. */
export function getHostX25519PublicKeyB64() {
  return load().x25519PublicKeyB64;
}

/** Open a tail sealed to this agent; null when it was not meant for us. */
export function openSealedTail(sealed) {
  return unsealTail(sealed, load().x25519PrivateKey);
}

export function signSdp(sdp) {
  const sig = crypto.sign(null, Buffer.from(sdp, "utf8"), load().privateKey);
  return sig.toString("base64");
}

// Same key, used to prove a session mutation came from this machine rather than
// from whoever knows the apiKey HEAD. Mirrors web/shared/utils/sessionMutationAuth.js.
const MUTATION_PREFIX = "9remote-session-v1";

export function signSessionMutation({ apiKey, tunnelUrl, localIp, expiryMinutes, ts }) {
  // Length-prefixed so no two different field splits produce one string.
  const field = (v) => {
    const s = v == null ? "" : String(v);
    return `${s.length}:${s}`;
  };
  const payload = `${MUTATION_PREFIX}|${field(apiKey)}${field(tunnelUrl)}${field(localIp)}${field(expiryMinutes)}${field(ts)}`;
  return crypto.sign(null, Buffer.from(payload, "utf8"), load().privateKey).toString("base64");
}

/** Body fields a mutating session request must carry to prove ownership. */
export function sessionMutationAuth(fields) {
  const ts = Date.now();
  return { ts, sig: signSessionMutation({ ...fields, ts }) };
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
