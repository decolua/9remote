// Tests for the agent-side live-output seq store + gap ring (plans F/G).
// Covers what breaks silently in production: a ring that leaks memory after a
// session dies, a gap slice that returns a WRONG range (would paint corrupted
// terminal content), and seq counters bleeding between sessions.
//
// Run: node agent/test/seqStore.test.mjs
import assert from "node:assert/strict";
import { nextSeq, currentSeq, cacheChunk, getGap, clearSession } from "../features/terminal/seqStore.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// getGap merges consecutive chunks into batched b64 packets, so a range's CONTENT is
// the concatenation of its packets and only the last seq of each packet is reported.
const gapText = (gap) => gap.map((c) => Buffer.from(c.data, "base64").toString("utf-8")).join("");

// Each test uses a unique session id — the store is module-level state.
let n = 0;
const sid = () => `s${++n}`;

// ── seq counter ────────────────────────────────────────────────────────────

test("seq starts at 1 and increments monotonically", () => {
  const s = sid();
  assert.equal(nextSeq(s), 1);
  assert.equal(nextSeq(s), 2);
  assert.equal(nextSeq(s), 3);
});

test("currentSeq reports the last issued seq without advancing it", () => {
  const s = sid();
  nextSeq(s); nextSeq(s);
  assert.equal(currentSeq(s), 2);
  assert.equal(currentSeq(s), 2, "currentSeq must not advance the counter");
  assert.equal(nextSeq(s), 3);
});

test("currentSeq of an unknown session is 0 (join before any output)", () => {
  assert.equal(currentSeq("never-seen"), 0);
});

test("sessions have independent counters (no cross-talk between terminals)", () => {
  const a = sid(), b = sid();
  nextSeq(a); nextSeq(a); nextSeq(a);
  assert.equal(nextSeq(b), 1, "second session must start its own numbering");
  assert.equal(currentSeq(a), 3);
});

// ── gap ring ───────────────────────────────────────────────────────────────

test("getGap returns the exact requested range, in order", () => {
  const s = sid();
  for (let i = 1; i <= 5; i++) cacheChunk(s, nextSeq(s), `d${i}`, undefined);
  const gap = getGap(s, 2, 4);
  assert.equal(gapText(gap), "d2d3d4");
  assert.equal(gap.at(-1).seq, 4, "last packet must carry the range's final seq");
});

test("getGap mixes b64 and raw chunks into one correctly decoded stream", () => {
  const s = sid();
  cacheChunk(s, nextSeq(s), Buffer.from("AB").toString("base64"), "b64");
  cacheChunk(s, nextSeq(s), "CD", undefined);
  const gap = getGap(s, 1, 2);
  assert.ok(gap.every((c) => c.enc === "b64"), "packets are always b64");
  assert.equal(gapText(gap), "ABCD");
});

test("single-chunk gap works (from === to)", () => {
  const s = sid();
  cacheChunk(s, nextSeq(s), "only", undefined);
  assert.equal(gapText(getGap(s, 1, 1)), "only");
});

test("a large gap is batched into few packets, not one per chunk", () => {
  const s = sid();
  const N = 400;
  for (let i = 1; i <= N; i++) cacheChunk(s, nextSeq(s), "x".repeat(1024), undefined);
  const gap = getGap(s, 1, N);
  assert.ok(gap.length < N / 10, `expected batching, got ${gap.length} packets for ${N} chunks`);
  assert.equal(gapText(gap).length, N * 1024, "no bytes lost in batching");
});

test("empty range (to < from) returns [] not null — nothing to send, not a miss", () => {
  const s = sid();
  cacheChunk(s, nextSeq(s), "x", undefined);
  assert.deepEqual(getGap(s, 2, 1), []);
});

test("missing chunk in the middle → null (caller must fall back to full replay)", () => {
  const s = sid();
  cacheChunk(s, 1, "a", undefined);
  cacheChunk(s, 3, "c", undefined); // 2 never cached
  assert.equal(getGap(s, 1, 3), null);
});

test("range past the newest chunk → null, never a short read", () => {
  const s = sid();
  cacheChunk(s, nextSeq(s), "a", undefined);
  assert.equal(getGap(s, 1, 5), null, "must not silently return a partial range");
});

test("unknown session → null (no crash, caller falls back)", () => {
  assert.equal(getGap("nope", 1, 3), null);
});

// ── ring eviction ──────────────────────────────────────────────────────────

test("ring evicts oldest chunks; evicted range reads as a miss, recent range hits", () => {
  const s = sid();
  const CHUNK = 64 * 1024;
  const N = 100; // 6.4MB > RING_MAX_BYTES (4MB)
  for (let i = 1; i <= N; i++) cacheChunk(s, nextSeq(s), "x".repeat(CHUNK), undefined);
  assert.equal(getGap(s, 1, 10), null, "long-evicted range must miss, not return stale data");
  assert.equal(gapText(getGap(s, N - 4, N)).length, 5 * CHUNK, "recent range must still hit");
});

test("ring is bounded by BYTES — a chatty stream of small chunks keeps a long window", () => {
  const s = sid();
  // 5000 tiny chunks are far under the byte cap: a count-based ring would have evicted
  // most of them, leaving a phone app-switch unrecoverable.
  for (let i = 1; i <= 5000; i++) cacheChunk(s, nextSeq(s), "x".repeat(10), undefined);
  assert.notEqual(getGap(s, 1, 5000), null, "small chunks must not be evicted by count");
  // And the cap does bite once the bytes are real.
  const big = sid();
  for (let i = 1; i <= 100; i++) cacheChunk(big, nextSeq(big), "y".repeat(64 * 1024), undefined);
  assert.equal(getGap(big, 1, 1), null, "byte cap must evict once exceeded");
});

// ── clearSession (the leak fix) ────────────────────────────────────────────

test("clearSession drops cached chunks so a dead session frees its ring", () => {
  const s = sid();
  for (let i = 1; i <= 5; i++) cacheChunk(s, nextSeq(s), `d${i}`, undefined);
  clearSession(s);
  assert.equal(getGap(s, 1, 5), null, "chunks must be gone after clearSession");
});

test("clearSession resets the counter so a reused id restarts at 1", () => {
  const s = sid();
  nextSeq(s); nextSeq(s);
  clearSession(s);
  assert.equal(currentSeq(s), 0);
  assert.equal(nextSeq(s), 1);
});

test("clearSession is idempotent and safe on an unknown id", () => {
  clearSession("ghost");
  clearSession("ghost");
  assert.equal(currentSeq("ghost"), 0);
});

test("clearSession only affects its own session", () => {
  const a = sid(), b = sid();
  cacheChunk(a, nextSeq(a), "a1", undefined);
  cacheChunk(b, nextSeq(b), "b1", undefined);
  clearSession(a);
  assert.equal(getGap(a, 1, 1), null);
  assert.equal(gapText(getGap(b, 1, 1)), "b1", "sibling session must survive");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
