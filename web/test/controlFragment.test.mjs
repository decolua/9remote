// A control envelope too big for one SCTP message is sliced and rejoined on the
// receiving side. Load-bearing: a broken slice path silently loses the message,
// and the carrier it was on (RTC) is the one that reaches the agent.
// Run: node --import ./test/loader-alias.mjs web/test/controlFragment.test.mjs
import assert from "node:assert/strict";
import { encodeFrame, decodeFrame, encodeFragments, createReassembler } from "../shared/transport/codec.js";

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push(Promise.resolve().then(() => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}));

const MAX = 65536;

// Mirrors what the receiving adapter does: parse each wire frame, hand it to the
// reassembler, and forward whatever comes out complete.
function receive(reassembler, frames) {
  const out = [];
  for (const frame of frames) {
    const env = reassembler.push(decodeFrame(frame));
    if (env) out.push(env);
  }
  return out;
}

test("send: a frame that fits goes out as one untouched frame", () => {
  const frames = encodeFragments({ event: "input", args: ["hi"], ackId: null }, MAX, 1);
  assert.equal(frames.length, 1);
  assert.deepEqual(decodeFrame(frames[0]).args, ["hi"]);
});

test("send: a pasted image round-trips whole, and every slice fits the DC", () => {
  const args = [{ filename: "shot.png", type: "image/png", content: "A".repeat(2 * 1024 * 1024) }];
  const frames = encodeFragments({ event: "ai:prompt", args, ackId: null }, MAX, 7);
  assert.ok(frames.length > 1, "must have been sliced");
  for (const f of frames) assert.ok(f.byteLength <= MAX, `slice ${f.byteLength} exceeds the DC limit`);

  const got = receive(createReassembler(), frames);
  assert.equal(got.length, 1);
  assert.equal(got[0].event, "ai:prompt");
  assert.deepEqual(got[0].args, args);
});

test("send: a binary payload round-trips byte-for-byte, ack id included", () => {
  const bytes = new Uint8Array(300 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  const frames = encodeFragments({ event: "paste", args: [bytes], ackId: "c_7" }, MAX, 8);

  const got = receive(createReassembler(), frames);
  assert.equal(got.length, 1);
  assert.equal(got[0].ackId, "c_7");
  assert.deepEqual([...got[0].args[0]], [...bytes]);
});

test("receive: parts arriving out of order still produce one message", () => {
  const args = [{ content: "B".repeat(250 * 1024) }];
  const frames = encodeFragments({ event: "ai:prompt", args, ackId: null }, MAX, 9);
  const shuffled = [frames[2], frames[0], frames[frames.length - 1], ...frames.slice(1, -1)];
  const got = receive(createReassembler(), shuffled);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].args, args);
});

test("receive: a duplicate part does not complete a message early", () => {
  const frames = encodeFragments({ event: "ai:prompt", args: [{ content: "C".repeat(250 * 1024) }] }, MAX, 10);
  const got = receive(createReassembler(), [frames[0], frames[0], frames[0]]);
  assert.equal(got.length, 0, "one part, seen three times, is still not the message");
});

test("receive: junk fragment markers are dropped, never allocated for", () => {
  const reassembler = createReassembler();
  const huge = encodeFrame({ event: "x", args: [new Uint8Array(8)] }, { id: 1, part: 0, parts: 999999 });
  assert.equal(reassembler.push(decodeFrame(huge)), null);
  const past = encodeFrame({ event: "x", args: [new Uint8Array(8)] }, { id: 2, part: 5, parts: 2 });
  assert.equal(reassembler.push(decodeFrame(past)), null);
});

test("receive: an unsliced frame passes straight through", () => {
  const got = receive(createReassembler(), [encodeFrame({ event: "input", args: ["hi"], ackId: null })]);
  assert.equal(got.length, 1);
  assert.equal(got[0].event, "input");
  assert.deepEqual(got[0].args, ["hi"]);
});

await Promise.all(tests);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
