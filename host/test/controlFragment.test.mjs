// A control envelope too big for one SCTP message is sliced and rejoined on the
// receiving side. The agent is the end that hands the bytes to the CLI, so a
// broken slice path here loses the user's image with no error anywhere.
// Run: node agent/test/controlFragment.test.mjs
import assert from "node:assert/strict";
import { encodeFrame, decodeFrame, encodeFragments, createReassembler } from "../transport/codec.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

console.log("Running control fragment tests...");

const MAX = 65536;

const receive = (reassembler, frames) => {
  const out = [];
  for (const frame of frames) {
    const env = reassembler.push(decodeFrame(frame));
    if (env) out.push(env);
  }
  return out;
};

await test("send: a frame that fits goes out as one untouched frame", () => {
  const frames = encodeFragments({ event: "output", args: ["hi"], ackId: null }, MAX, 1);
  assert.equal(frames.length, 1);
  assert.deepEqual(decodeFrame(frames[0]).args, ["hi"]);
});

await test("send: a big string payload round-trips, and every slice fits the DC", () => {
  const args = [{ sessionId: "s1", cwd: "/tmp", attachments: [{ filename: "shot.png", type: "image/png", content: "A".repeat(2 * 1024 * 1024) }] }];
  const frames = encodeFragments({ event: "ai:prompt", args, ackId: "c_3" }, MAX, 2);
  assert.ok(frames.length > 1, "must have been sliced");
  for (const f of frames) assert.ok(f.length <= MAX, `slice ${f.length} exceeds the DC limit`);

  const got = receive(createReassembler(), frames);
  assert.equal(got.length, 1);
  assert.equal(got[0].event, "ai:prompt");
  assert.equal(got[0].ackId, "c_3");
  assert.deepEqual(got[0].args, args);
});

await test("send: a Buffer payload round-trips byte-for-byte", () => {
  const bytes = Buffer.alloc(300 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  const frames = encodeFragments({ event: "output", args: [{ sessionId: "s1", enc: "bin", data: bytes }] }, MAX, 4);

  const got = receive(createReassembler(), frames);
  assert.equal(got.length, 1);
  assert.deepEqual([...got[0].args[0].data], [...bytes]);
});

await test("receive: parts arriving out of order still produce one message", () => {
  const args = [{ content: "B".repeat(250 * 1024) }];
  const frames = encodeFragments({ event: "ai:prompt", args, ackId: null }, MAX, 5);
  const shuffled = [frames[2], frames[0], frames[frames.length - 1], ...frames.slice(1, -1)];
  const got = receive(createReassembler(), shuffled);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].args, args);
});

await test("receive: a duplicate part does not complete a message early", () => {
  const frames = encodeFragments({ event: "ai:prompt", args: [{ content: "C".repeat(250 * 1024) }] }, MAX, 6);
  const got = receive(createReassembler(), [frames[0], frames[0], frames[0]]);
  assert.equal(got.length, 0, "one part, seen three times, is still not the message");
});

await test("receive: junk fragment markers are dropped, never allocated for", () => {
  const reassembler = createReassembler();
  const huge = encodeFrame({ event: "x", args: [Buffer.alloc(8)] }, { id: 1, part: 0, parts: 999999 });
  assert.equal(reassembler.push(decodeFrame(huge)), null);
  const past = encodeFrame({ event: "x", args: [Buffer.alloc(8)] }, { id: 2, part: 5, parts: 2 });
  assert.equal(reassembler.push(decodeFrame(past)), null);
});

await test("receive: an unsliced frame passes straight through", () => {
  const got = receive(createReassembler(), [encodeFrame({ event: "output", args: ["hi"], ackId: null })]);
  assert.equal(got.length, 1);
  assert.equal(got[0].event, "output");
  assert.deepEqual(got[0].args, ["hi"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
