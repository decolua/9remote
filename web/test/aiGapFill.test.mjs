// Gap-fill decisions for the live ai:event stream (web/features/ai/lib/gapFill.js).
// Run: node --import ./test/loader-alias.mjs web/test/aiGapFill.test.mjs
import assert from "node:assert/strict";
import { classifyLiveEvent, fetchedIsSafe } from "../features/ai/lib/gapFill.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
};

console.log("Running ai gapFill tests...");

test("contiguous event in the same generation applies", () => {
  assert.equal(classifyLiveEvent({ seq: 6, epoch: 7 }, { appliedSeq: 5, logEpoch: 7 }), "apply");
});

test("event at/below the watermark is a duplicate", () => {
  assert.equal(classifyLiveEvent({ seq: 5, epoch: 7 }, { appliedSeq: 5, logEpoch: 7 }), "dup");
  assert.equal(classifyLiveEvent({ seq: 3, epoch: 7 }, { appliedSeq: 5, logEpoch: 7 }), "dup");
});

test("a seq jump inside one generation is a gap", () => {
  assert.equal(classifyLiveEvent({ seq: 8, epoch: 7 }, { appliedSeq: 5, logEpoch: 7 }), "gap");
});

test("a newer generation is a resync, an older one is stale", () => {
  assert.equal(classifyLiveEvent({ seq: 2, epoch: 8 }, { appliedSeq: 5, logEpoch: 7 }), "resync");
  assert.equal(classifyLiveEvent({ seq: 2, epoch: 8 }, { appliedSeq: 1, logEpoch: 7 }), "resync");
  assert.equal(classifyLiveEvent({ seq: 9, epoch: 6 }, { appliedSeq: 5, logEpoch: 7 }), "stale");
});

test("the first stamped event seeds the generation", () => {
  assert.equal(classifyLiveEvent({ seq: 3, epoch: 9 }, { appliedSeq: 0, logEpoch: null }), "adopt");
});

test("an unstamped or old-host event keeps the pre-patch behavior", () => {
  assert.equal(classifyLiveEvent({ seq: null }, { appliedSeq: 5, logEpoch: 7 }), "apply");
  // No generation known: a jump cannot be trusted as a hole — apply, as before.
  assert.equal(classifyLiveEvent({ seq: 9 }, { appliedSeq: 5, logEpoch: null }), "apply");
  // Old host stamps nothing: never a gap.
  assert.equal(classifyLiveEvent({ seq: 9, epoch: null }, { appliedSeq: 5, logEpoch: 7 }), "apply");
});

test("a fetched range starting at watermark+1 applies whole", () => {
  const res = fetchedIsSafe([{ seq: 6, event: "tool_start", data: {} }, { seq: 7, event: "turn_complete", data: {} }], 5);
  assert.deepEqual(res, { safe: true, apply: [{ seq: 6, event: "tool_start", data: {} }, { seq: 7, event: "turn_complete", data: {} }] });
});

test("a fetched range that still starts above the hole is unsafe", () => {
  assert.equal(fetchedIsSafe([{ seq: 7, event: "init", data: {} }], 5).safe, false);
});

test("a compacted stream record overlapping the watermark is unsafe", () => {
  // Compaction merged seq 5 and 6 into one record: its text half-exists on the client.
  const merged = { seq: 6, event: "delta", data: { text: "ab" }, _fromSeq: 5 };
  assert.equal(fetchedIsSafe([merged], 5).safe, false);
  // A merged run entirely above the watermark — starting exactly at it plus one — is fine.
  const above = { seq: 6, event: "delta", data: { text: "ab" }, _fromSeq: 6 };
  assert.equal(fetchedIsSafe([above], 5).safe, true);
});

test("an empty or fully-duplicate fetch is safe and applies nothing", () => {
  assert.deepEqual(fetchedIsSafe([], 5), { safe: true, apply: [] });
  assert.deepEqual(fetchedIsSafe([{ seq: 4, event: "init", data: {} }], 5), { safe: true, apply: [] });
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
