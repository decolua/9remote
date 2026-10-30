// Sequenced control stream — pure-logic tests for the ring + intake sequencer,
// plus the codec v2 roundtrip of the new envelope fields (sq/ep/rs).
// Run: node host/test/seqStream.test.mjs
import assert from "node:assert/strict";
import { createOutboundLog, createIntake, STREAM_EVENTS } from "../transport/seqStream.js";
import { encodeFrame, decodeFrame, encode, decode } from "../transport/codec.js";

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push(Promise.resolve().then(async () => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}));

// Fake clock: no timers fire unless the test pumps them.
function fakeTimers() {
  const at = [];
  return {
    schedule: (fn, ms) => { at.push({ fn, ms }); return at.length - 1; },
    clearFn: (id) => { if (id !== null) at[id] = null; },
    fire: () => { const p = at.filter(Boolean); at.length = 0; p.forEach(({ fn }) => fn()); }
  };
}

function makeIntake(opts = {}) {
  const delivered = [];
  const gaps = [];
  const losses = [];
  let dupes = 0;
  const t = fakeTimers();
  const intake = createIntake({
    holdMax: 4,
    gapDeadlineMs: 100,
    deliver: (env) => delivered.push(env),
    requestGap: (from, to) => gaps.push([from, to]),
    onLoss: (from, to) => losses.push([from, to]),
    onDupe: () => dupes++,
    schedule: t.schedule,
    clearFn: t.clearFn,
    ...opts
  });
  return { intake, delivered, gaps, losses, get dupes() { return dupes; }, timers: t };
}

// ── outbound ring ─────────────────────────────────────────────────────────────

test("ring: append stamps monotonic seq; range returns entries in order", () => {
  const log = createOutboundLog({ maxBytes: 1 << 20, maxEntries: 100 });
  const a = log.append({ event: "output", args: [{ id: 1 }] });
  const b = log.append({ event: "output", args: [{ id: 2 }] });
  assert.equal(a.sq, 1);
  assert.equal(b.sq, 2);
  const r = log.range(1, 2);
  assert.equal(r.length, 2);
  assert.deepEqual(r[1], { event: "output", args: [{ id: 2 }], ackId: null, sq: 2 });
  assert.equal(log.range(1, 3), null, "beyond nextSeq is a miss");
});

test("ring: hot path ships only the unsent tail (markSent = carrier accepted)", () => {
  const log = createOutboundLog({ maxBytes: 1 << 20, maxEntries: 100 });
  for (let i = 0; i < 3; i++) log.append({ event: "e", args: [i] });
  log.markSent(2);
  assert.deepEqual(log.unsentList().map((e) => e.sq), [3], "1..2 taken by a carrier");
});

test("ring: carrier event replays sent-but-unconfirmed; rs watermark prunes it", () => {
  const log = createOutboundLog({ maxBytes: 1 << 20, maxEntries: 100 });
  for (let i = 0; i < 4; i++) log.append({ event: "e", args: [i] });
  log.markSent(4);        // all accepted by a carrier that then died
  assert.deepEqual(log.replayList().map((e) => e.sq), [1, 2, 3, 4], "nothing confirmed → full window replays");
  log.setApplied(3);      // peer confirmed 1..3 via rs
  assert.deepEqual(log.replayList().map((e) => e.sq), [4]);
  assert.deepEqual(log.unsentList(), [], "hot path stays quiet once the tail is sent");
});

test("ring: eviction drops oldest and counts unsent losses", () => {
  const log = createOutboundLog({ maxBytes: 1200, maxEntries: 100 });
  for (let i = 0; i < 8; i++) log.append({ event: "e", args: ["x".repeat(32)] });
  assert.equal(log.range(1, 1), null, "oldest evicted");
  assert.equal(log.range(4, 8).length, 5, "recent range still covered");
  assert.equal(log.droppedUnsent, 3, "evicted entries were never sent");
});

// ── intake sequencer ──────────────────────────────────────────────────────────

test("intake: unarmed passes through and tracks maxSeen; arm() baselines without a false gap", () => {
  const { intake, delivered, gaps } = makeIntake();
  intake.push({ event: "a", sq: 5, ep: "E" });
  intake.push({ event: "b", args: [] });           // legacy envelope (no sq)
  assert.equal(delivered.length, 2, "unarmed delivers everything");
  intake.arm();
  intake.push({ event: "c", sq: 6, ep: "E" });
  assert.equal(delivered.length, 3, "6 > maxSeen(5) is contiguous after arming — no NACK");
  intake.push({ event: "d", sq: 6, ep: "E" });
  assert.equal(delivered.length, 3, "duplicate dropped");
  assert.equal(gaps.length, 0);
});

test("intake: armed before any envelope baselines at the first sequenced sq", () => {
  const { intake, delivered, gaps } = makeIntake();
  intake.arm();
  intake.push({ event: "a", sq: 5, ep: "E1" });
  assert.equal(delivered.length, 1, "late joiner: baseline sits just under the first sq");
  assert.equal(gaps.length, 0, "no NACK for 1..4 — the peer's own replay covers those");
});

test("intake: gap holds later envelopes, NACKs the range, releases in order when filled", () => {
  const { intake, delivered, gaps } = makeIntake();
  intake.arm();
  intake.push({ event: "a", sq: 1, ep: "E" });
  intake.push({ event: "c", sq: 3, ep: "E" });
  assert.deepEqual(delivered.map((e) => e.event), ["a"], "3 waits for 2");
  assert.deepEqual(gaps, [[2, 2]], "hole [2..2] requested");
  intake.push({ event: "b", sq: 2, ep: "E" });
  assert.deepEqual(delivered.map((e) => e.event), ["a", "b", "c"], "held released in seq order");
});

test("intake: one NACK per hole — a burst behind the hole does not re-ask", () => {
  const { intake, gaps } = makeIntake();
  intake.arm();
  intake.push({ event: "a", sq: 1, ep: "E" });
  intake.push({ event: "c", sq: 3, ep: "E" });
  intake.push({ event: "d", sq: 4, ep: "E" });
  intake.push({ event: "e", sq: 5, ep: "E" });
  assert.equal(gaps.length, 1, "same hole ⇒ single request");
});

test("intake: gapMissed skips the hole and delivers the held tail with a loss report", () => {
  const { intake, delivered, gaps, losses } = makeIntake();
  intake.arm();
  intake.push({ event: "a", sq: 1, ep: "E" });
  intake.push({ event: "d", sq: 4, ep: "E" });
  intake.gapMissed(2);
  assert.deepEqual(losses, [[2, 3]], "the skipped range is reported");
  assert.deepEqual(delivered.map((e) => e.event), ["a", "d"]);
  assert.equal(gaps.length, 1, "the one NACK that could not be served — never re-asked");
});

test("intake: deadline fires → hole skipped (feature layers re-fill)", () => {
  const { intake, delivered, losses, timers } = makeIntake();
  intake.arm();
  intake.push({ event: "a", sq: 1, ep: "E" });
  intake.push({ event: "z", sq: 9, ep: "E" });
  timers.fire();
  assert.deepEqual(losses, [[2, 8]]);
  assert.deepEqual(delivered.map((e) => e.event), ["a", "z"]);
});

test("intake: hold overflow skips the hole instead of growing without bound", () => {
  const { intake, delivered, losses } = makeIntake({ holdMax: 2 });
  intake.arm();
  intake.push({ event: "a", sq: 1, ep: "E" });
  intake.push({ event: "x", sq: 3, ep: "E" });
  intake.push({ event: "y", sq: 4, ep: "E" });
  intake.push({ event: "z", sq: 5, ep: "E" }); // third held entry → overflow
  assert.deepEqual(losses, [[2, 2]]);
  assert.deepEqual(delivered.map((e) => e.event), ["a", "x", "y", "z"]);
});

test("intake: peer epoch change resyncs from zero — seq rewind is not 'stale'", () => {
  const { intake, delivered } = makeIntake();
  intake.arm();
  intake.push({ event: "a", sq: 5, ep: "E1" });
  intake.push({ event: "b", sq: 1, ep: "E2" }); // host restarted: new epoch, seq from 1
  assert.deepEqual(delivered.map((e) => e.event), ["a", "b"]);
});

test("intake: paused freezes the deadline; resume re-asks the hole", () => {
  const { intake, gaps, timers } = makeIntake();
  intake.arm();
  intake.push({ event: "a", sq: 1, ep: "E" });
  intake.push({ event: "c", sq: 3, ep: "E" });
  intake.setPaused(true);
  timers.fire(); // nothing may fire while paused
  intake.setPaused(false);
  assert.equal(gaps.length, 2, "resume re-requests the still-open hole");
});

// ── codec v2/v1 roundtrip of the stream fields ────────────────────────────────

test("codec: v2 frame carries sq/ep/rs through decodeFrame", () => {
  const env = { event: "output", args: [{ data: Buffer.from([1, 2, 3]) }], ackId: "c_7", sq: 42, ep: "E", rs: 39 };
  const out = decodeFrame(encodeFrame(env));
  assert.equal(out.sq, 42);
  assert.equal(out.ep, "E");
  assert.equal(out.rs, 39);
  assert.equal(out.ackId, "c_7");
  assert.deepEqual(out.args[0].data, Buffer.from([1, 2, 3]));
});

test("codec: v1 JSON envelope keeps the fields for legacy-carrier peers", () => {
  const out = decode(encode({ event: "statusChange", args: [{ s: 1 }], sq: 3, ep: "E", rs: null }));
  assert.equal(out.sq, 3);
  assert.equal(out.ep, "E");
  assert.equal(out.rs, null);
});

test("codec: an old decoder ignores the new fields — envelope stays well-formed", () => {
  const buf = encodeFrame({ event: "e", args: [], sq: 9, ep: "E", rs: 1 });
  const headerLen = buf.readUInt32LE(0);
  const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8"));
  assert.equal(header.event, "e");
  assert.ok(Array.isArray(header.lens), "old header shape intact");
});

await Promise.all(tests);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
