// The client seals on WebCrypto, the agent opens on node:crypto. Two
// implementations of the same construction, which is exactly where this kind of
// thing breaks: a different HKDF salt, a tag appended instead of separate, a
// key exported in the wrong form — each produces code that passes its own tests
// and fails against the other side.
//
// So these run both implementations against each other rather than each alone.
// Run: node --import ./test/loader-alias.mjs web/test/tailSealInterop.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sealTailFor as sealNode, unsealTail, hostFp2Of as fp2Node } from "../../agent/lib/tailSeal.js";
import { sealTail as sealWeb, hostFp2Of as fp2Web } from "../shared/transport/lib/tailSeal.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const host = crypto.generateKeyPairSync("x25519");
const HOST_PUB = host.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
const ED_PUB = crypto.generateKeyPairSync("ed25519").publicKey
  .export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
const TAIL = "mnpqrstu";

console.log("Suite 1: what the browser seals, the agent opens");

await test("a tail sealed on WebCrypto is recovered by the agent", async () => {
  const sealed = await sealWeb(TAIL, HOST_PUB);
  assert.notEqual(sealed, null, "the web side refused to seal");
  assert.equal(unsealTail(sealed, host.privateKey), TAIL);
});

await test("a longer tail survives the round trip", async () => {
  // Nothing depends on the tail's length, but a size that crosses a block
  // boundary is where a padding assumption would show.
  const long = "x".repeat(200);
  const sealed = await sealWeb(long, HOST_PUB);
  assert.equal(unsealTail(sealed, host.privateKey), long);
});

await test("both sides produce the same shape on the wire", async () => {
  const fromWeb = await sealWeb(TAIL, HOST_PUB);
  const fromNode = sealNode(TAIL, HOST_PUB);
  assert.deepEqual(Object.keys(fromWeb).sort(), Object.keys(fromNode).sort());
  for (const k of ["epk", "iv", "ct"]) {
    assert.equal(typeof fromWeb[k], "string", `${k} not a string`);
    // Same lengths mean the same key/iv sizes and the same tag placement.
    assert.equal(fromWeb[k].length, fromNode[k].length, `${k} length differs`);
  }
});

await test("the browser's sealing is not deterministic either", async () => {
  const a = await sealWeb(TAIL, HOST_PUB);
  const b = await sealWeb(TAIL, HOST_PUB);
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.epk, b.epk);
});

await test("the tail is not readable in what the browser sends", async () => {
  const sealed = await sealWeb(TAIL, HOST_PUB);
  assert.ok(!JSON.stringify(sealed).includes(TAIL));
});

await test("a wrong agent key does not open the browser's seal", async () => {
  const other = crypto.generateKeyPairSync("x25519");
  const sealed = await sealWeb(TAIL, HOST_PUB);
  assert.equal(unsealTail(sealed, other.privateKey), null);
});

await test("the browser refuses an unusable key rather than sealing to nothing", async () => {
  for (const pub of [null, undefined, "", "AAAA", "not-base64!!"]) {
    assert.equal(await sealWeb(TAIL, pub), null, `sealed to ${JSON.stringify(pub)}`);
  }
});

console.log("Suite 2: both sides compute the same fingerprint");

await test("fp2 agrees between agent and browser", async () => {
  // The user reads this off the agent's screen and the browser compares it. A
  // mismatch here would reject every legitimate pairing.
  assert.equal(await fp2Web(ED_PUB, HOST_PUB), fp2Node(ED_PUB, HOST_PUB));
});

await test("fp2 agrees across many key pairs", async () => {
  for (let i = 0; i < 20; i++) {
    const ed = crypto.generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    const x = crypto.generateKeyPairSync("x25519").publicKey
      .export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    assert.equal(await fp2Web(ed, x), fp2Node(ed, x), `differed on pair ${i}`);
  }
});

await test("fp2 spreads over the alphabet", async () => {
  // A construction that always lands on a few characters would quietly shrink
  // the 10 bits the pairing code is counting on.
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const x = crypto.generateKeyPairSync("x25519").publicKey
      .export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    seen.add(fp2Node(ED_PUB, x));
  }
  assert.ok(seen.size > 100, `only ${seen.size} distinct fp2 in 200 keys`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
