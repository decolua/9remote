// The key TAIL travels to the agent in the connect handshake, verbatim. That is
// safe over the RTC channel and it is what the whole split-key design rests on
// — the Worker never sees it. But the WS carrier is a Cloudflare tunnel, and
// anyone who can take over that path reads the tail off the wire and has a
// terminal on the machine.
//
// Sealing it closes that: the client encrypts to the agent's X25519 key, which
// it learned through fp2 — two characters read off the agent's own screen, the
// one channel the server cannot reach.
//
// Run: node --test agent/test/sealedTail.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sealTailFor, unsealTail, hostFp2Of } from "../lib/tailSeal.js";

function hostKeys() {
  const x = crypto.generateKeyPairSync("x25519");
  const ed = crypto.generateKeyPairSync("ed25519");
  return {
    x25519Priv: x.privateKey,
    x25519Pub: x.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
    ed25519Pub: ed.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64")
  };
}

const HOST = hostKeys();
const TAIL = "mnpqrstu";

// ── The round trip ──────────────────────────────────────────────────────────

test("the agent recovers exactly what the client sealed", () => {
  const sealed = sealTailFor(TAIL, HOST.x25519Pub);
  assert.equal(unsealTail(sealed, HOST.x25519Priv), TAIL);
});

test("the tail does not appear anywhere in the sealed form", () => {
  // The point of the exercise: what goes over the wire must not contain it.
  const sealed = sealTailFor(TAIL, HOST.x25519Pub);
  const wire = JSON.stringify(sealed);
  assert.ok(!wire.includes(TAIL), `tail visible in ${wire}`);
  assert.ok(!Buffer.from(wire).includes(Buffer.from(TAIL)), "tail visible as bytes");
});

test("sealing twice gives different bytes", () => {
  // A deterministic sealing would let an observer match two connections as
  // carrying the same tail, and would reuse a key stream.
  const a = sealTailFor(TAIL, HOST.x25519Pub);
  const b = sealTailFor(TAIL, HOST.x25519Pub);
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.epk, b.epk);
  assert.notEqual(a.iv, b.iv);
});

// ── What an interceptor can do with it ──────────────────────────────────────

test("another agent's key does not open it", () => {
  const other = hostKeys();
  const sealed = sealTailFor(TAIL, HOST.x25519Pub);
  assert.equal(unsealTail(sealed, other.x25519Priv), null);
});

test("altering the ciphertext is refused, not decrypted to garbage", () => {
  // AES-GCM authenticates; a flipped bit must fail the tag rather than produce
  // a wrong tail that then fails a comparison for the wrong reason.
  const sealed = sealTailFor(TAIL, HOST.x25519Pub);
  const bytes = Buffer.from(sealed.ct, "base64");
  bytes[0] ^= 1;
  assert.equal(unsealTail({ ...sealed, ct: bytes.toString("base64") }, HOST.x25519Priv), null);
});

test("swapping in a different ephemeral key is refused", () => {
  // The obvious attack for someone who caught one sealed tail: reseal it under
  // a key they control. Without the matching secret the tag will not verify.
  const sealed = sealTailFor(TAIL, HOST.x25519Pub);
  const attacker = crypto.generateKeyPairSync("x25519");
  const epk = attacker.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  assert.equal(unsealTail({ ...sealed, epk }, HOST.x25519Priv), null);
});

test("replaying the iv from another sealing is refused", () => {
  const a = sealTailFor(TAIL, HOST.x25519Pub);
  const b = sealTailFor(TAIL, HOST.x25519Pub);
  assert.equal(unsealTail({ ...a, iv: b.iv }, HOST.x25519Priv), null);
});

// ── Malformed input ─────────────────────────────────────────────────────────

test("nothing malformed decrypts, and nothing throws", () => {
  // This runs on attacker-supplied bytes on a public carrier: it has to answer
  // null, never crash the connection handler.
  const bad = [
    null, undefined, {}, [], "string", 42,
    { epk: "", iv: "", ct: "" },
    { epk: "not-base64!!", iv: "x", ct: "y" },
    { epk: "AAAA", iv: "AAAA", ct: "AAAA" },
    { epk: Buffer.alloc(31).toString("base64"), iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" },
    { epk: Buffer.alloc(64).toString("base64"), iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }
  ];
  for (const input of bad) {
    assert.equal(unsealTail(input, HOST.x25519Priv), null, `accepted ${JSON.stringify(input)}`);
  }
});

test("sealing refuses a key that is not a key", () => {
  for (const pub of [null, undefined, "", "not-base64!!", "AAAA", 42, {}]) {
    assert.equal(sealTailFor(TAIL, pub), null, `sealed to ${JSON.stringify(pub)}`);
  }
});

test("sealing refuses an empty tail", () => {
  assert.equal(sealTailFor("", HOST.x25519Pub), null);
  assert.equal(sealTailFor(null, HOST.x25519Pub), null);
});

// ── The fingerprint that anchors the key ────────────────────────────────────

test("fp2 covers both host keys", () => {
  // One fingerprint anchors the signing key and the sealing key together, so
  // reading two characters off the screen vouches for both. Changing either
  // must change what the user sees.
  const base = hostFp2Of(HOST.ed25519Pub, HOST.x25519Pub);
  const other = hostKeys();
  assert.notEqual(hostFp2Of(other.ed25519Pub, HOST.x25519Pub), base, "signing key not covered");
  assert.notEqual(hostFp2Of(HOST.ed25519Pub, other.x25519Pub), base, "sealing key not covered");
});

test("fp2 is two characters from the confusable-free alphabet", () => {
  const fp2 = hostFp2Of(HOST.ed25519Pub, HOST.x25519Pub);
  assert.equal(fp2.length, 2);
  assert.match(fp2, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{2}$/);
});

test("fp2 is stable for the same pair", () => {
  assert.equal(
    hostFp2Of(HOST.ed25519Pub, HOST.x25519Pub),
    hostFp2Of(HOST.ed25519Pub, HOST.x25519Pub)
  );
});

test("the two keys cannot be swapped to forge the same fp2", () => {
  // Concatenating without a separator would let one key borrow bytes from the
  // other. Both are fixed 32 bytes here, but the ordering must still matter.
  assert.notEqual(
    hostFp2Of(HOST.ed25519Pub, HOST.x25519Pub),
    hostFp2Of(HOST.x25519Pub, HOST.ed25519Pub)
  );
});
