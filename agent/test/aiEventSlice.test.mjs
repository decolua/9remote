// Tests for the AI chat log windowing (agent/features/terminal/aiEventSlice.js).
// Run: node agent/test/aiEventSlice.test.mjs
import assert from "node:assert/strict";
import { aiTailStart, aiHistoryChunk } from "../features/terminal/aiEventSlice.js";

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

console.log("Running AI event slice tests...");

const turn = (seq, size = 200) => [
  { seq: seq, event: "user_message", data: { text: "u".repeat(size) } },
  { seq: seq + 1, event: "delta", data: { text: "d".repeat(size) } },
  { seq: seq + 2, event: "turn_complete", data: { stats: {} } }
];
const log = (count) => Array.from({ length: count }, (_, i) => i).flatMap((i) => turn(i * 3 + 1));

test("a log under the budget is replayed whole", () => {
  const events = log(5);
  assert.equal(aiTailStart(events, 1024 * 1024), 0);
});

test("a long log replays only its tail", () => {
  const events = log(50);
  const from = aiTailStart(events, 4096);
  assert.ok(from > 0, "must drop older events");
  assert.equal(events[from].event, "user_message", "tail starts on a turn boundary");
  assert.ok(events.length - from < events.length);
});

test("scroll-up returns the chunk just older than the held seq", () => {
  const events = log(50);
  const { events: older, hasMore } = aiHistoryChunk(events, 60, 4096);
  assert.ok(older.length > 0);
  assert.ok(older.every((e) => e.seq < 60), "never repeats events the client holds");
  assert.equal(older[older.length - 1].seq, 59, "ends right before the held seq");
  assert.equal(older[0].event, "user_message", "starts on a turn boundary");
  assert.equal(hasMore, true);
});

test("scrolling back to the first turn reports no more older events", () => {
  const events = log(50);
  const { events: older, hasMore } = aiHistoryChunk(events, 4, 4096);
  assert.deepEqual(older.map((e) => e.seq), [1, 2, 3]);
  assert.equal(hasMore, false);
});

test("a chunk never starts mid-turn, and never drags in an earlier turn", () => {
  // The boundary lands inside turn 2, whose own prompt is short — the byte walk crosses
  // back into turn 1. Snapping must pick turn 2's user_message, not turn 1's: an
  // earlier one would return a whole extra turn and make turn 1 unfetchable later.
  const events = [
    { seq: 1, event: "user_message", data: { text: "u".repeat(9000) } },
    { seq: 2, event: "delta", data: { text: "d".repeat(9000) } },
    { seq: 3, event: "turn_complete", data: {} },
    { seq: 4, event: "user_message", data: { text: "u" } },
    { seq: 5, event: "delta", data: { text: "d" } },
    { seq: 6, event: "turn_complete", data: {} }
  ];
  const { events: older, hasMore } = aiHistoryChunk(events, 4, 9000);
  assert.equal(older[0].event, "user_message");
  assert.equal(older[0].seq, 1, "starts on the containing turn's prompt");
  assert.equal(hasMore, true);
});

test("a request with no held seq fetches nothing (the join already sent the tail)", () => {
  const events = log(5);
  const { events: older, hasMore } = aiHistoryChunk(events, 0, 4096);
  assert.deepEqual(older, []);
  assert.equal(hasMore, false);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
