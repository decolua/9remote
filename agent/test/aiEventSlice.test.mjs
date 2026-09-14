// Tests for the AI chat log windowing (agent/features/ai/aiEventSlice.js).
// Run: node agent/test/aiEventSlice.test.mjs
import assert from "node:assert/strict";
import { aiTailStart, aiHistoryChunk, aiEventBytes, windowBytes, replayWindow } from "../features/ai/aiEventSlice.js";
import { AI_REPLAY_BYTES } from "../features/ai/constants.js";

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

test("a chunk never drags in an earlier turn than the one it lands in", () => {
  // Turn 1 is past the budget on its own; turn 2 is tiny. Walking back from turn 2's
  // boundary crosses into turn 1 — pulling it in would double the chunk and push the
  // frame past the wire cap, so the chunk starts at turn 2's own prompt instead.
  const events = [
    { seq: 1, event: "user_message", data: { text: "u".repeat(9000) } },
    { seq: 2, event: "delta", data: { text: "d".repeat(9000) } },
    { seq: 3, event: "turn_complete", data: {} },
    { seq: 4, event: "user_message", data: { text: "u" } },
    { seq: 5, event: "delta", data: { text: "d" } },
    { seq: 6, event: "turn_complete", data: {} }
  ];
  const { events: older, hasMore } = aiHistoryChunk(events, 7, 9000);
  assert.equal(older[0].event, "user_message");
  assert.equal(older[0].seq, 4, "starts on the containing turn's prompt");
  assert.ok(older.every((e) => e.seq >= 4), "turn 1 stays out of this chunk");
  assert.equal(hasMore, true);
});

test("a request with no held seq fetches nothing (the join already sent the tail)", () => {
  const events = log(5);
  const { events: older, hasMore } = aiHistoryChunk(events, 0, 4096);
  assert.deepEqual(older, []);
  assert.equal(hasMore, false);
});

// ── Seq monotonicity ──
// The host numbers each event with a counter, never with its position in the log: the
// log shrinks under it (delta compaction at every turn end, `shift()` past the event
// cap), and a seq read off the length went backwards — the client's scroll-up walks
// `e.seq >= before` and stops at the first such event, hiding every older turn.
test("a log whose seqs went backwards leaves the older turns unreachable", () => {
  // 50 turns, then a compaction that renumbers the tail's deltas down. The client holds
  // the tail and asks for what is older; the walk stops at the first out-of-order seq.
  const events = log(50);
  for (let i = 60; i < 90; i++) events[i] = { ...events[i], seq: events[i].seq - 30 };

  const { events: older } = aiHistoryChunk(events, 121, 4096);
  assert.ok(older.length > 0);
  // The chunk cannot reach past the renumbered stretch, so turns before it never load.
  assert.ok(older[0].seq > 1, "older turns are stranded behind the bad seqs");
});

test("a monotonic log reaches all the way back to the first turn", () => {
  const events = log(50).map((e, i) => ({ ...e, seq: i + 1 }));
  let before = 130;
  let reached = before;
  for (let i = 0; i < 50 && before > 0; i++) {
    const { events: older, hasMore } = aiHistoryChunk(events, before, 4096);
    if (!older.length) break;
    reached = older[0].seq;
    before = reached;
    if (!hasMore) break;
  }
  assert.equal(reached, 1, "paging lands on turn 1");
});

// ── The wire budget ──
// The reply rides the RTC control DC as ONE serialized frame (see codec.js), and the
// SCTP message cap is 65536 — an oversize frame throws and the client is left on
// "Syncing…" forever. So the window has to be measured the way the wire measures it.
test("an event is measured as it serializes, not by the text it carries", () => {
  const ev = { seq: 1, event: "tool_result", data: { id: "t", name: "Bash", output: "x".repeat(100) } };
  assert.equal(aiEventBytes(ev), JSON.stringify(ev).length, "must match the serialized event");
  assert.ok(aiEventBytes(ev) > 100, "keys and metadata around the output still cost bytes");
});

test("a window of real events fits the SCTP message cap", () => {
  const SCTP_MAX = 65536;
  // Same shape as a live turn: prompts, streamed deltas, and fat tool results.
  const events = Array.from({ length: 60 }, (_, i) => [
    { seq: i * 3 + 1, event: "user_message", data: { text: "p".repeat(400) } },
    { seq: i * 3 + 2, event: "tool_result", data: { id: `t${i}`, name: "Bash", output: "o".repeat(4000) } },
    { seq: i * 3 + 3, event: "turn_complete", data: { stats: {} } }
  ]).flat();

  const tail = events.slice(aiTailStart(events, AI_REPLAY_BYTES));
  assert.ok(tail.length > 0, "the tail must not come back empty");
  assert.ok(JSON.stringify(tail).length <= SCTP_MAX, "the replayed tail must fit one SCTP message");

  const { events: older } = aiHistoryChunk(events, events.at(-1).seq + 1, AI_REPLAY_BYTES);
  assert.ok(JSON.stringify(older).length <= SCTP_MAX, "a scroll-up chunk must fit one SCTP message too");
});

test("a turn that cannot fit does not swallow the log", () => {
  // Same shape as a long agentic turn: hundreds of events with no prompt of its own, so
  // the walk back to a `user_message` reaches the top of the log. Snapping there is what
  // made the reply the whole conversation — over the cap, and thrown away every re-ask.
  const events = [
    { seq: 1, event: "user_message", data: { text: "u".repeat(500) } },
    ...Array.from({ length: 40 }, (_, i) => ({ seq: i + 2, event: "thinking", data: { text: "t".repeat(2000) } })),
    { seq: 42, event: "user_message", data: { text: "u".repeat(500) } },
    ...Array.from({ length: 20 }, (_, i) => ({ seq: i + 43, event: "delta", data: { text: "d".repeat(2000) } }))
  ];
  const from = aiTailStart(events, 8192);
  assert.ok(from > 0, "must not replay the whole log");
  assert.ok(windowBytes(events.slice(from)) <= 8192, "the window fits the budget");
  assert.ok(events[from].seq >= 42, "the earlier turn stays out of this window");
});

test("a turn that fits is still snapped to whole", () => {
  const events = [
    { seq: 1, event: "user_message", data: { text: "u".repeat(500) } },
    ...Array.from({ length: 40 }, (_, i) => ({ seq: i + 2, event: "thinking", data: { text: "t".repeat(2000) } })),
    { seq: 42, event: "user_message", data: { text: "u" } },
    ...Array.from({ length: 3 }, (_, i) => ({ seq: i + 43, event: "delta", data: { text: "d".repeat(100) } }))
  ];
  const from = aiTailStart(events, 8192);
  assert.equal(events[from].seq, 42, "the whole containing turn is replayed");
  assert.equal(events[from].event, "user_message", "with its prompt above it");
});

test("an event too wide for any window is stepped over, never left as a hole", () => {
  // A payload nested deeper than the log's own cap walks reaches here whole. It can never
  // be sent, and the window around it must stay CONTIGUOUS: handing back its neighbours
  // without it would read to the client as history that never happened.
  const events = [
    { seq: 1, event: "user_message", data: { text: "u".repeat(200) } },
    { seq: 2, event: "tool_result", data: { output: "o".repeat(200000) } },
    { seq: 3, event: "delta", data: { text: "d".repeat(200) } }
  ];
  // The trailing side is one unbroken run — nothing behind the gap is dragged across it.
  assert.deepEqual(replayWindow(events, 4096).events.map((e) => e.seq), [3]);

  // Paging walks over the gap, so what sits behind it is still reachable rather than
  // stranded, and the scroll-up never comes back with the same impossible chunk.
  const { events: older, hasMore } = aiHistoryChunk(events, 3, 4096);
  assert.deepEqual(older.map((e) => e.seq), [1], "the fetch reaches across the gap");
  assert.equal(hasMore, false, "and knows it reached the top");
});

test("an oversize event at the tail does not empty the window", () => {
  const events = [
    { seq: 1, event: "user_message", data: { text: "u".repeat(200) } },
    { seq: 2, event: "delta", data: { text: "d".repeat(200) } },
    { seq: 3, event: "tool_result", data: { output: "o".repeat(200000) } }
  ];
  const tail = replayWindow(events, 4096).events;
  assert.deepEqual(tail.map((e) => e.seq), [1, 2], "the replay is the events behind it");
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
