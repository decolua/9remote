// Tests for bufferSlice — ANSI-boundary-safe slicing of a chunked Buffer[].
// Run: node agent/test/bufferSlice.test.mjs
import assert from "node:assert/strict";
import { takeBufferTail, takeBufferRange, scanBackForEsc, bufferTotal } from "../features/terminal/bufferSlice.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const ESC = 0x1b;
const buf = (s) => Buffer.from(s, "utf8");
// A TUI redraw frame: cursor positioning + SGR color runs, like Claude Code output.
// "...<ESC>[6G<ESC>[38;2;10;20;30mTEXT..." repeated.
const FRAME = buf("\x1b[6G\x1b[38;2;10;20;30mTEXT");
const FRAMES = buf("\x1b[6G\x1b[38;2;10;20;30mTEXT".repeat(3));

// --- bufferTotal ---
test("bufferTotal sums chunk lengths", () => {
  assert.equal(bufferTotal([buf("abc"), buf("de")]), 5);
  assert.equal(bufferTotal([]), 0);
  assert.equal(bufferTotal(null), 0);
});

// --- takeBufferTail: basic ---
test("takeBufferTail returns full tail when ≤ maxLen", () => {
  const chunks = [buf("hello"), buf("world")];
  assert.equal(takeBufferTail(chunks, 100).toString(), "helloworld");
});

test("takeBufferTail returns last N bytes", () => {
  const chunks = [buf("hello"), buf("world")];
  assert.equal(takeBufferTail(chunks, 3).toString(), "rld");
});

test("takeBufferTail empty when maxLen=0 or no chunks", () => {
  assert.equal(takeBufferTail([buf("x")], 0).length, 0);
  assert.equal(takeBufferTail([], 100).length, 0);
});

// --- takeBufferTail: ANSI boundary ---
test("takeBufferTail skips forward to next ESC when cut is mid-sequence", () => {
  // Construct so the byte cut lands inside an ANSI escape (between ESC and its params).
  // "...AAAA\x1b[38;2;10" → cut 5 bytes from end lands at ";10", missing the leading ESC.
  const chunks = [buf("AAAA"), buf("\x1b[38;2;10")];
  const tail = takeBufferTail(chunks, 5);
  // Tail must start at ESC (0x1b), not at a fragment like ";10".
  assert.equal(tail[0], ESC, "tail should start at ESC boundary");
});

test("takeBufferTail bounded skip — returns unchanged if no ESC within window", () => {
  // 600 bytes of plain text (no ESC) → skip can't find ESC within 512B limit → keep as-is.
  const chunks = [buf("A".repeat(600))];
  const tail = takeBufferTail(chunks, 100);
  assert.equal(tail.length, 100);
  // First byte is not ESC (no escape in the plain text), and we kept the slice.
  assert.notEqual(tail[0], ESC);
});

test("takeBufferTail handles multi-chunk: boundary found in earlier chunk", () => {
  const chunks = [buf("XYZ\x1b[38;2"), buf("10;20;30mTEXT")];
  // Cut near the end lands mid-sequence in chunk 2; ESC lives in chunk 1.
  const tail = takeBufferTail(chunks, 8);
  assert.equal(tail[0], ESC);
});

// --- scanBackForEsc ---
test("scanBackForEsc finds the ESC immediately before the cut", () => {
  const chunks = [buf("AAAA\x1b[BBBB")]; // ESC at abs offset 4
  assert.equal(scanBackForEsc(chunks, 8), 4);
});

test("scanBackForEsc returns fromAbs unchanged when no ESC in window", () => {
  const chunks = [buf("AAAAAAAAAA")]; // no ESC at all
  assert.equal(scanBackForEsc(chunks, 5), 5);
});

test("scanBackForEsc respects maxExtend bound", () => {
  // ESC at offset 2, cut at offset 100, maxExtend=5 → no ESC in [95,100) → unchanged.
  const chunks = [buf("\x1b[" + "A".repeat(98))];
  assert.equal(scanBackForEsc(chunks, 100, 5), 100);
});

test("scanBackForEsc crosses chunk boundaries", () => {
  // ESC in chunk 1 at offset 4, cut in chunk 2.
  const chunks = [buf("AAAA\x1b["), buf("BBBB")];
  assert.equal(scanBackForEsc(chunks, 9), 4);
});

// --- takeBufferRange: basic ---
test("takeBufferRange returns slice before held tail", () => {
  // buffer = "0123456789", have=3 (client holds "789"), chunkLen=4 → prefix "3456"
  const chunks = [buf("0123456789")];
  const r = takeBufferRange(chunks, 3, 4);
  assert.equal(r.prefix.toString(), "3456");
  assert.equal(r.extra, 0);
});

test("takeBufferRange clamps when chunkLen exceeds available", () => {
  const chunks = [buf("0123456789")];
  const r = takeBufferRange(chunks, 8, 100); // only 2 bytes before "89"
  assert.equal(r.prefix.toString(), "0123456");
});

// --- takeBufferRange: ANSI extension (no data loss) ---
test("takeBufferRange EXTENDS start back to ESC (no bytes lost)", () => {
  // buffer = "AAAA\x1b[38;2;10;20;30mXXXX" — 24 bytes. ESC at offset 4.
  // have=4 (client holds last 4 "XXXX"), chunkLen=8 → raw start = 24-4-8 = 12 (mid "30mXXXX").
  // Should extend back to ESC at offset 4: prefix includes the full escape + the 8 bytes.
  const chunks = [buf("AAAA\x1b[38;2;10;20;30mXXXX")];
  const r = takeBufferRange(chunks, 4, 8);
  assert.equal(r.prefix[0], ESC, "prefix starts at ESC");
  assert.ok(r.extra > 0, "extra reports the bytes extended back");
  // prefix length = chunkLen + extra
  assert.equal(r.prefix.length, 8 + r.extra);
});

test("takeBufferRange: consecutive fetches cover full buffer without gaps", () => {
  // Two scroll-up fetches should cover the whole older region; the `extra` extension in fetch 1
  // is the exact start of fetch 2, so no bytes are skipped between them.
  const body = buf("AAAA\x1b[1mBBBB\x1b[0mCCCC\x1b[2mDDDD");
  const chunks = [body];
  const total = body.length;
  // Fetch 1: have=4 (last 4 "DDDD"), chunkLen=8
  const f1 = takeBufferRange(chunks, 4, 8);
  // Next have = 4 + f1.prefix.length (web consumes prefix bytes). Fetch 2 from there.
  const have2 = 4 + f1.prefix.length;
  const f2 = takeBufferRange(chunks, have2, 100); // rest
  // Union of both fetches + the original held tail should reconstruct the full buffer body.
  const reconstructed = Buffer.concat([f2.prefix, f1.prefix, body.subarray(body.length - 4)]);
  assert.equal(reconstructed.toString(), body.toString());
});

test("takeBufferRange handles multi-chunk", () => {
  const chunks = [buf("AAAA\x1b["), buf("38;2;10m"), buf("TEXT")];
  const r = takeBufferRange(chunks, 4, 5); // have last 4 "TEXT", want 5 before
  assert.equal(r.prefix[0], ESC, "prefix starts at ESC even across chunk boundary");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
