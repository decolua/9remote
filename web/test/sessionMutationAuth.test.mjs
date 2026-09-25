// Mutating a session — repointing its tunnel, deleting it — was gated on
// the key-shape check alone. The apiKey it
// checks is the HEAD, and the HEAD is public by design: /api/connect hands it
// out and every device that ever paired keeps a copy. So anyone holding one
// could repoint the victim's tunnelUrl at a host of their own, and the clients
// that followed it would present their key tail to whatever answered.
//
// The agent signs those mutations now with the Ed25519 host key it already owns
// (hostKey.js, the same key that signs SDP answers). The rules below are the
// whole contract, including the part that lets agents predating this keep
// working.
// Run: node --import ./test/loader-alias.mjs web/test/sessionMutationAuth.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mutationPayload, checkMutationAuth, canReplaceHostKey, MUTATION_MAX_SKEW_MS } from "../shared/utils/sessionMutationAuth.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// A stand-in for the agent's host key: same curve, same raw-32 wire format.
function makeHostKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey,
    publicKeyB64: spki.subarray(-32).toString("base64"),
    sign: (msg) => crypto.sign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64")
  };
}

const HOST = makeHostKey();
const OTHER = makeHostKey();
const KEY = "sk-abcd1234-qrstuvwx";
const NOW = 1_700_000_000_000;

const signed = (fields, key = HOST, at = NOW) => ({
  ...fields,
  ts: at,
  sig: key.sign(mutationPayload({ ...fields, ts: at }))
});

// ── Agents that predate the change ──────────────────────────────────────────

console.log("Suite 1: a session with no registered key behaves as before");

await test("an unsigned mutation is accepted", async () => {
  // An agent running the previous release cannot sign. Refusing it would take
  // its tunnel offline on the next sync, which is a worse outcome than the
  // exposure this closes — it upgrades into protection on its own.
  const verdict = await checkMutationAuth({
    storedPublicKey: null,
    body: { apiKey: KEY, tunnelUrl: "https://a.example" },
    now: NOW
  });
  assert.equal(verdict.ok, true);
});

await test("a signed mutation is accepted too", async () => {
  // The agent registers its key and signs in the same release, but the two
  // reach the Worker as separate requests — an update can land first.
  const verdict = await checkMutationAuth({
    storedPublicKey: null,
    body: signed({ apiKey: KEY, tunnelUrl: "https://a.example" }),
    now: NOW
  });
  assert.equal(verdict.ok, true);
});

// ── Once a key is on file ───────────────────────────────────────────────────

console.log("Suite 2: a registered key makes the signature mandatory");

await test("the agent's own signature passes", async () => {
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: signed({ apiKey: KEY, tunnelUrl: "https://real.example" }),
    now: NOW
  });
  assert.equal(verdict.ok, true);
});

await test("an unsigned mutation is refused", async () => {
  // The attack as reported: HEAD in the body, nothing else.
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: { apiKey: KEY, tunnelUrl: "https://evil.tld" },
    now: NOW
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "signature-required");
});

await test("a signature from a different key is refused", async () => {
  // An attacker can generate a keypair; it just is not the one on file.
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: signed({ apiKey: KEY, tunnelUrl: "https://evil.tld" }, OTHER),
    now: NOW
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "bad-signature");
});

await test("a signature does not carry over to a different tunnelUrl", async () => {
  // Replaying a captured signature with the URL swapped is the obvious next
  // move, so the URL has to be inside what was signed.
  const body = signed({ apiKey: KEY, tunnelUrl: "https://real.example" });
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: { ...body, tunnelUrl: "https://evil.tld" },
    now: NOW
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "bad-signature");
});

await test("a signature does not carry over to a different apiKey", async () => {
  const body = signed({ apiKey: KEY, tunnelUrl: "https://real.example" });
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: { ...body, apiKey: "sk-zzzzzzzz-qrstuvwx" },
    now: NOW
  });
  assert.equal(verdict.ok, false);
});

await test("localIp is covered by the signature", async () => {
  const body = signed({ apiKey: KEY, tunnelUrl: "https://real.example", localIp: "192.168.1.5:2208" });
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: { ...body, localIp: "10.0.0.1:2208" },
    now: NOW
  });
  assert.equal(verdict.ok, false);
});

await test("a delete signs the same way, with no tunnelUrl", async () => {
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: signed({ apiKey: KEY }),
    now: NOW
  });
  assert.equal(verdict.ok, true);
});

// ── Replay ──────────────────────────────────────────────────────────────────

console.log("Suite 3: a captured signature does not stay useful");

await test("a stale timestamp is refused", async () => {
  const old = NOW - MUTATION_MAX_SKEW_MS - 1000;
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: signed({ apiKey: KEY, tunnelUrl: "https://real.example" }, HOST, old),
    now: NOW
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "stale");
});

await test("a timestamp from the future is refused", async () => {
  // Clock skew cuts both ways, so the window is symmetric rather than one-sided.
  const ahead = NOW + MUTATION_MAX_SKEW_MS + 1000;
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: signed({ apiKey: KEY, tunnelUrl: "https://real.example" }, HOST, ahead),
    now: NOW
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "stale");
});

await test("a modest clock difference still works", async () => {
  // Agents run on laptops that sleep; the window has to tolerate real drift.
  for (const drift of [-60_000, 60_000]) {
    const verdict = await checkMutationAuth({
      storedPublicKey: HOST.publicKeyB64,
      body: signed({ apiKey: KEY, tunnelUrl: "https://real.example" }, HOST, NOW + drift),
      now: NOW
    });
    assert.equal(verdict.ok, true, `drift ${drift} rejected`);
  }
});

await test("the timestamp itself cannot be edited after signing", async () => {
  const body = signed({ apiKey: KEY, tunnelUrl: "https://real.example" }, HOST, NOW - 1000);
  const verdict = await checkMutationAuth({
    storedPublicKey: HOST.publicKeyB64,
    body: { ...body, ts: NOW },
    now: NOW
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "bad-signature");
});

// ── Malformed input ─────────────────────────────────────────────────────────

console.log("Suite 4: nothing malformed slips past as valid");

await test("a non-string signature is refused", async () => {
  for (const sig of [null, 42, {}, [], ""]) {
    const verdict = await checkMutationAuth({
      storedPublicKey: HOST.publicKeyB64,
      body: { apiKey: KEY, tunnelUrl: "https://x", ts: NOW, sig },
      now: NOW
    });
    assert.equal(verdict.ok, false, `accepted sig ${JSON.stringify(sig)}`);
  }
});

await test("a non-numeric timestamp is refused", async () => {
  for (const ts of [null, "now", {}, NaN]) {
    const verdict = await checkMutationAuth({
      storedPublicKey: HOST.publicKeyB64,
      body: { apiKey: KEY, tunnelUrl: "https://x", ts, sig: "AAAA" },
      now: NOW
    });
    assert.equal(verdict.ok, false, `accepted ts ${JSON.stringify(ts)}`);
  }
});

await test("garbage in the signature field does not throw", async () => {
  // Verification runs on attacker-supplied bytes; it has to fail, not crash.
  for (const sig of ["not-base64!!", "AAAA", "%%%%"]) {
    const verdict = await checkMutationAuth({
      storedPublicKey: HOST.publicKeyB64,
      body: { apiKey: KEY, tunnelUrl: "https://x", ts: NOW, sig },
      now: NOW
    });
    assert.equal(verdict.ok, false);
  }
});

await test("a corrupt stored key refuses rather than admits", async () => {
  const verdict = await checkMutationAuth({
    storedPublicKey: "not-a-key",
    body: signed({ apiKey: KEY, tunnelUrl: "https://x" }),
    now: NOW
  });
  assert.equal(verdict.ok, false);
});

// ── The signed string ───────────────────────────────────────────────────────

console.log("Suite 5: the payload cannot be made ambiguous");

await test("field boundaries cannot be shifted", async () => {
  // Concatenation without separators would let one field borrow from the next
  // and produce the same string from different values.
  const a = mutationPayload({ apiKey: "sk-a", tunnelUrl: "bc", ts: 1 });
  const b = mutationPayload({ apiKey: "sk-ab", tunnelUrl: "c", ts: 1 });
  assert.notEqual(a, b);
});

await test("absent and empty are not the same payload", async () => {
  const absent = mutationPayload({ apiKey: KEY, ts: 1 });
  const empty = mutationPayload({ apiKey: KEY, tunnelUrl: "", ts: 1 });
  assert.equal(absent, empty, "both should normalise to the same empty field");
  const present = mutationPayload({ apiKey: KEY, tunnelUrl: "https://x", ts: 1 });
  assert.notEqual(absent, present);
});

await test("the same input always produces the same payload", async () => {
  const fields = { apiKey: KEY, tunnelUrl: "https://x", localIp: "10.0.0.1", ts: NOW };
  assert.equal(mutationPayload(fields), mutationPayload({ ...fields }));
});

// ── Re-registering a host key ───────────────────────────────────────────────

console.log("Suite 6: when a machine legitimately gets a new host key");

await test("a new key does not silently replace the stored one", async () => {
  // Reinstalling the agent loses hostKey.json and generates a fresh pair. If
  // session/create simply took the newest key, anyone holding the HEAD could
  // register their own and sign whatever they liked — the escape hatch has to
  // cost something only the real owner can pay.
  assert.equal(canReplaceHostKey({ stored: HOST.publicKeyB64, presented: OTHER.publicKeyB64, pairedNow: false }), false);
});

await test("re-registering the same key is not a replacement", async () => {
  // Every restart re-runs session/create with the key it already registered.
  assert.equal(canReplaceHostKey({ stored: HOST.publicKeyB64, presented: HOST.publicKeyB64, pairedNow: false }), true);
});

await test("a live pairing code authorises the replacement", async () => {
  // The user read a code off the agent's own screen — out-of-band proof that
  // they are at the machine, which is exactly what a reinstall can offer.
  assert.equal(canReplaceHostKey({ stored: HOST.publicKeyB64, presented: OTHER.publicKeyB64, pairedNow: true }), true);
});

await test("the first registration needs no pairing", async () => {
  assert.equal(canReplaceHostKey({ stored: null, presented: HOST.publicKeyB64, pairedNow: false }), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
