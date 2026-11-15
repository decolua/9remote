// Gap-fill decisions for the live ai:event stream (web/features/ai/lib/gapFill.js).
// Run: node --import ./test/loader-alias.mjs web/test/aiGapFill.test.mjs
import assert from "node:assert/strict";
import { classifyLiveEvent, fetchedIsSafe, splitByHole } from "../features/ai/lib/gapFill.js";

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

// ── splitByHole: the queue-drain law shared by the hydrate release and the gap drain ──

test("splitByHole: a contiguous queue applies whole and reports the new watermark", () => {
  const r = splitByHole(
    [{ seq: 6, event: "delta", data: { text: "a" } }, { seq: 7, event: "tool_start", data: {} }],
    { appliedSeq: 5, logEpoch: 7 }
  );
  assert.equal(r.resync, false);
  assert.deepEqual(r.apply.map((i) => i.seq), [6, 7]);
  assert.deepEqual(r.held, []);
  assert.equal(r.appliedSeq, 7);
  assert.equal(r.logEpoch, 7);
});

test("splitByHole: a hole holds the suffix instead of walking the watermark over it", () => {
  const r = splitByHole(
    [{ seq: 6, event: "delta", data: {}, epoch: 7 }, { seq: 9, event: "delta", data: {}, epoch: 7 }, { seq: 10, event: "turn_complete", data: {}, epoch: 7 }],
    { appliedSeq: 5, logEpoch: 7 }
  );
  assert.deepEqual(r.apply.map((i) => i.seq), [6]);
  assert.deepEqual(r.held.map((i) => i.seq), [9, 10]);
  assert.equal(r.appliedSeq, 6, "the watermark must stop at the hole");
});

test("splitByHole: a head hole holds everything", () => {
  const r = splitByHole([{ seq: 8, event: "delta", data: {}, epoch: 7 }], { appliedSeq: 5, logEpoch: 7 });
  assert.deepEqual(r.apply, []);
  assert.deepEqual(r.held.map((i) => i.seq), [8]);
  assert.equal(r.appliedSeq, 5);
});

test("splitByHole: duplicates and stale events drop without stopping the apply", () => {
  const r = splitByHole(
    [{ seq: 4, event: "delta", data: {} }, { seq: 6, event: "delta", data: {} }, { seq: 7, event: "delta", data: {}, epoch: 6 }],
    { appliedSeq: 5, logEpoch: 7 }
  );
  assert.deepEqual(r.apply.map((i) => i.seq), [6]);
  assert.deepEqual(r.held, []);
});

test("splitByHole: a reset restarts the counters mid-queue", () => {
  const r = splitByHole(
    [{ seq: 6, event: "conversation_reset", data: { epoch: 9 } }, { seq: 1, event: "delta", data: {} }, { seq: 2, event: "delta", data: {} }],
    { appliedSeq: 5, logEpoch: 7 }
  );
  assert.deepEqual(r.apply.map((i) => i.seq), [6, 1, 2]);
  assert.equal(r.appliedSeq, 2);
  assert.equal(r.logEpoch, 9);
});

test("splitByHole: a reset behind a hole is held, not applied", () => {
  const r = splitByHole(
    [{ seq: 9, event: "delta", data: {}, epoch: 7 }, { event: "conversation_reset", data: { epoch: 9 } }],
    { appliedSeq: 5, logEpoch: 7 }
  );
  assert.deepEqual(r.apply, []);
  assert.equal(r.held.length, 2, "the reset must wait behind the hole");
});

test("splitByHole: a newer generation signals resync and drops the held tail", () => {
  const r = splitByHole(
    [{ seq: 6, event: "delta", data: {} }, { seq: 2, event: "delta", data: {}, epoch: 8 }],
    { appliedSeq: 5, logEpoch: 7 }
  );
  assert.equal(r.resync, true);
  assert.deepEqual(r.apply.map((i) => i.seq), [6]);
  assert.deepEqual(r.held, []);
});

test("splitByHole: the first stamped event seeds the generation (adopt)", () => {
  const r = splitByHole([{ seq: 3, event: "delta", data: {}, epoch: 9 }], { appliedSeq: 2, logEpoch: null });
  assert.deepEqual(r.apply.map((i) => i.seq), [3]);
  assert.equal(r.logEpoch, 9);
});

test("splitByHole: unstamped events apply without moving the watermark", () => {
  const r = splitByHole([{ seq: null, event: "delta", data: {} }], { appliedSeq: 5, logEpoch: 7 });
  assert.equal(r.apply.length, 1);
  assert.equal(r.appliedSeq, 5);
});

test("splitByHole: nothing slips past a hole, even unstamped events", () => {
  const r = splitByHole(
    [{ seq: 9, event: "delta", data: {}, epoch: 7 }, { seq: null, event: "cli_event", data: {} }],
    { appliedSeq: 5, logEpoch: 7 }
  );
  assert.deepEqual(r.apply, []);
  assert.equal(r.held.length, 2, "order after the hole must be preserved");
});

test("splitByHole: an empty queue applies nothing", () => {
  assert.deepEqual(splitByHole([], { appliedSeq: 5, logEpoch: 7 }), { apply: [], held: [], resync: false, appliedSeq: 5, logEpoch: 7 });
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
