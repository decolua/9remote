// Proof that a session mutation came from the machine the session belongs to.
//
// The routes that repoint or delete a session used to accept the apiKey alone.
// That key is the HEAD — routing data the design treats as public: /api/connect
// returns it, and every device that ever paired holds one, including devices
// since revoked. Holding it was enough to point someone's tunnelUrl at a host of
// your own, and their clients would then hand their key tail to whatever
// answered there.
//
// The host already keeps an Ed25519 host key for signing SDP answers. It signs
// these mutations with the same key and registers the public half on the session
// row, so the Worker can tell the owner from anyone who merely knows the HEAD.
//
// A row with no key on file accepts unsigned mutations. That is what keeps
// hosts released before this from losing their tunnel on the next sync; a row
// gains its protection the first time an updated host registers, and does not
// give it up afterwards.

// Hosts run on laptops that suspend and resume with drifted clocks, so the
// window is wide enough to survive that and narrow enough that a captured
// signature stops working long before anyone could use it.
export const MUTATION_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * The exact bytes the host signs.
 *
 * Length-prefixed rather than concatenated: "sk-a" + "bc" and "sk-ab" + "c"
 * produce identical strings otherwise, so one signature would cover two
 * different requests.
 */
export function mutationPayload({ apiKey, tunnelUrl, localIp, expiryMinutes, ts }) {
  const field = (v) => {
    const s = v == null ? "" : String(v);
    return `${s.length}:${s}`;
  };
  return `9remote-session-v1|${field(apiKey)}${field(tunnelUrl)}${field(localIp)}${field(expiryMinutes)}${field(ts)}`;
}

const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
]);

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verify(publicKeyB64, message, sigB64) {
  // The wire format is the raw 32-byte key; WebCrypto wants SPKI here, and
  // Workers' Ed25519 import is stricter than Node's about which it accepts.
  const raw = b64ToBytes(publicKeyB64);
  if (raw.length !== 32) return false;
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + 32);
  spki.set(ED25519_SPKI_PREFIX, 0);
  spki.set(raw, ED25519_SPKI_PREFIX.length);

  const key = await crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
  return await crypto.subtle.verify(
    "Ed25519",
    key,
    b64ToBytes(sigB64),
    new TextEncoder().encode(message)
  );
}

/**
 * May session/create write this host key onto the row?
 *
 * A reinstalled host loses hostKey.json and comes back with a new pair, so the
 * row cannot be sealed forever — but taking whichever key arrives last would
 * undo the whole thing, since anyone holding the HEAD could register their own.
 *
 * `pairedNow` is a live pairing code presented with the request: the user read
 * six characters off the host's own screen, which is a claim only someone at
 * the machine can make, and the same claim the pairing flow already rests on.
 */
export function canReplaceHostKey({ stored, presented, pairedNow }) {
  if (!stored) return true;              // first registration
  if (stored === presented) return true; // every restart re-sends the same key
  return pairedNow === true;
}

/**
 * May this mutation proceed?
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkMutationAuth({ storedPublicKey, body, now = Date.now() }) {
  // Nothing registered yet — an agent from before this change, still trusted to
  // keep its own session current.
  if (!storedPublicKey) return { ok: true };

  const { sig, ts } = body || {};
  if (typeof sig !== "string" || !sig) return { ok: false, reason: "signature-required" };
  if (typeof ts !== "number" || !Number.isFinite(ts)) return { ok: false, reason: "signature-required" };
  if (Math.abs(now - ts) > MUTATION_MAX_SKEW_MS) return { ok: false, reason: "stale" };

  try {
    const ok = await verify(storedPublicKey, mutationPayload(body), sig);
    return ok ? { ok: true } : { ok: false, reason: "bad-signature" };
  } catch {
    // Malformed base64, a corrupt stored key, an unsupported curve — all of it
    // reaches here as a refusal, never as a pass.
    return { ok: false, reason: "bad-signature" };
  }
}
