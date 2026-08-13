// Tests for the terminal live-output seq gap detector (plan F).
// Covers the race/edge cases that would silently corrupt terminal content on
// resume from background: gap detection, duplicate/late chunks, post-replay
// sync, and the fast-path (no-gap → no reset, no race).
//
// Run: node web/test/seqGap.test.mjs
import assert from "node:assert/strict";
import {
  classifyLiveChunk,
  syncAfterReplay,
  GAP_INIT,
  GAP_NONE,
  GAP_DETECTED,
  GAP_STALE
} from "../features/terminal/lib/seqGap.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ── Basic classification ───────────────────────────────────────────────────

test("first ever live chunk (no prior lastSeq) → INIT, never a false gap", () => {
  assert.equal(classifyLiveChunk(null, 1), GAP_INIT);
  assert.equal(classifyLiveChunk(undefined, 0), GAP_INIT);
});

test("contiguous chunk → NONE (fast path: keep buffer, no reset, no race)", () => {
  assert.equal(classifyLiveChunk(5, 6), GAP_NONE);
  assert.equal(classifyLiveChunk(0, 1), GAP_NONE);
});

test("leap forward → DETECTED (missing chunks lost during background)", () => {
  assert.equal(classifyLiveChunk(5, 8), GAP_DETECTED);
  assert.equal(classifyLiveChunk(5, 7), GAP_DETECTED);
  // gap of exactly 1 missing chunk still counts (6 missing from 5→7)
  assert.equal(classifyLiveChunk(5, 7), GAP_DETECTED);
});

test("duplicate or late chunk (<= lastSeq) → STALE (ignore, do not rewind)", () => {
  assert.equal(classifyLiveChunk(5, 5), GAP_STALE);
  assert.equal(classifyLiveChunk(5, 3), GAP_STALE);
  assert.equal(classifyLiveChunk(10, 1), GAP_STALE);
});

// ── Boundaries ─────────────────────────────────────────────────────────────

test("seq=0 boundary works (first live chunk of a fresh session)", () => {
  assert.equal(classifyLiveChunk(null, 0), GAP_INIT);
  assert.equal(classifyLiveChunk(0, 1), GAP_NONE);
});

test("large seq stays correct near MAX_SAFE_INTEGER", () => {
  const big = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(classifyLiveChunk(big, big + 1), GAP_NONE);
  assert.equal(classifyLiveChunk(big - 2, big), GAP_DETECTED);
});

// ── Post-replay sync (the key anti-false-gap mechanism) ────────────────────

test("syncAfterReplay returns the tail's last seq as the new lastSeq", () => {
  assert.equal(syncAfterReplay(100), 100);
  assert.equal(syncAfterReplay(0), 0);
});

test("after replay sync, next live chunk is contiguous (no false gap)", () => {
  // Gap detected → reset + replay tail (tail ends at seq 100) → live 101 arrives.
  // Without sync, classifyLiveChunk(5, 101) would be a FALSE gap.
  let lastSeq = 5;
  assert.equal(classifyLiveChunk(lastSeq, 8), GAP_DETECTED);
  lastSeq = syncAfterReplay(100); // replay painted tail ending at seq 100
  assert.equal(classifyLiveChunk(lastSeq, 101), GAP_NONE);
});

// ── Race scenarios ─────────────────────────────────────────────────────────

test("reconnect with no output loss → NONE (warm fast path, zero race)", () => {
  // Background 2s, nothing dropped. lastSeq=5, first live chunk after resume = 6.
  let lastSeq = 5;
  assert.equal(classifyLiveChunk(lastSeq, 6), GAP_NONE);
  lastSeq = 6;
  assert.equal(classifyLiveChunk(lastSeq, 7), GAP_NONE);
});

test("reconnect after output lost in background → DETECTED on first live chunk", () => {
  // Chunks 6,7 dropped while WS/RTC zombie. Resume: first live = 8.
  let lastSeq = 5;
  assert.equal(classifyLiveChunk(lastSeq, 8), GAP_DETECTED);
});

test("reordered late chunk after a gap is already detected → STALE (first-leap wins)", () => {
  // WS/RTC delivered chunk 8 before the late 6. classify already flagged gap at 8.
  // After reset, lastSeq is resynced from the replay tail; the late 6 (now < lastSeq) is STALE.
  let lastSeq = 5;
  assert.equal(classifyLiveChunk(lastSeq, 8), GAP_DETECTED);
  lastSeq = syncAfterReplay(8); // replay tail caught up to 8
  assert.equal(classifyLiveChunk(lastSeq, 6), GAP_STALE); // late straggler, ignore
});

test("burst of contiguous chunks after resume — all NONE, no false positives", () => {
  let lastSeq = 100;
  for (let s = 101; s <= 150; s++) {
    assert.equal(classifyLiveChunk(lastSeq, s), GAP_NONE);
    lastSeq = s;
  }
});

test("duplicate of just-rendered chunk (retransmit) → STALE, not re-applied", () => {
  let lastSeq = 42;
  assert.equal(classifyLiveChunk(lastSeq, 43), GAP_NONE);
  lastSeq = 43;
  assert.equal(classifyLiveChunk(lastSeq, 43), GAP_STALE); // retransmit
});

test("non-monotonic jump backward across reconnect boundary → STALE", () => {
  // Old buffered chunk from before a reset arrives after replay already advanced.
  let lastSeq = syncAfterReplay(200);
  assert.equal(classifyLiveChunk(lastSeq, 50), GAP_STALE);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
