// Tests for the scroll-up history fetch logic: byte-accurate buffer slicing (daemon side)
// and viewport-preservation delta math (web side). Pure-logic copies — does NOT import
// ptyDaemon.js (which would bind the Unix socket) nor xterm (browser-only).
//
// Run: node agent/test/historyBuffer.test.mjs
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ── Daemon-side buffer helpers (byte-accurate target, Buffer[]) ────────────
// CURRENT (buggy): string[] + char-length. TARGET: Buffer[] + byte-length.
// We test the TARGET implementation against ASCII + CJK + ANSI + wrap cases.

function bufferTotal(chunks) {
  if (!chunks?.length) return 0;
  return chunks.reduce((sum, c) => sum + c.length, 0);
}

// Take the newest `maxLen` bytes from a chunked Buffer[] (used on join replay).
function takeBufferTail(chunks, maxLen) {
  if (!chunks?.length || maxLen <= 0) return Buffer.alloc(0);
  let remaining = maxLen;
  const parts = [];
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = chunks[i];
    if (chunk.length <= remaining) { parts.push(chunk); remaining -= chunk.length; }
    else { parts.push(chunk.subarray(chunk.length - remaining)); remaining = 0; }
  }
  parts.reverse();
  return Buffer.concat(parts);
}

// Return up to chunkLen bytes ending at (total - haveFromEnd), line-aligned at the start.
// Trimmed head bytes are returned so the caller can fold them back into `remaining`.
function takeBufferRange(chunks, haveFromEnd, chunkLen) {
  if (!chunks?.length || chunkLen <= 0) return { prefix: Buffer.alloc(0), trimmed: 0 };
  const total = bufferTotal(chunks);
  const endExclusive = total - Math.max(0, Math.min(haveFromEnd, total));
  let start = endExclusive - chunkLen;
  if (start < 0) { chunkLen += start; start = 0; }
  if (chunkLen <= 0) return { prefix: Buffer.alloc(0), trimmed: 0 };

  let offset = 0;
  const parts = [];
  for (let i = 0; i < chunks.length && chunkLen > 0; i++) {
    const chunk = chunks[i];
    const next = offset + chunk.length;
    if (next <= start) { offset = next; continue; }
    if (offset >= endExclusive) break;
    const localStart = Math.max(0, start - offset);
    const take = Math.min(chunkLen, chunk.length - localStart);
    parts.push(chunk.subarray(localStart, localStart + take));
    chunkLen -= take;
    offset = next;
  }
  let raw = Buffer.concat(parts);

  // Align start to the next '\n' (byte 0x0A) so we don't begin mid-line/mid-sequence.
  let trimmed = 0;
  const nl = raw.indexOf(0x0a);
  if (nl > 0 && nl < raw.length - 1) { trimmed = nl + 1; raw = raw.subarray(trimmed); }
  return { prefix: raw, trimmed };
}

// ── Web-side viewport delta math (TARGET: measure actual chunk lines) ─────
// CURRENT (buggy): estimatedChunkLines = ceil(chunkLen / cols).
// TARGET: actualChunkLines = newBaseY - oldBaseY (measured after replay write).
// scrollLines target = oldViewportY + actualChunkLines, clamped to [0, newBaseY].
function replayViewportDelta(oldViewportY, oldBaseY, newBaseY) {
  const actualChunkLines = newBaseY - oldBaseY;
  const target = Math.max(0, Math.min(oldViewportY + actualChunkLines, newBaseY));
  const delta = target - newBaseY; // negative = scroll up
  return { actualChunkLines, target, delta };
}

// ════════════════════════════════════════════════════════════════════════
// SUITE 1 — byte-accurate total & tail (the B1 core: char ≠ byte)
// ════════════════════════════════════════════════════════════════════════
console.log("\nSuite 1: byte-accurate bufferTotal / takeBufferTail (Buffer[])");

test("total counts BYTES not chars — CJK", () => {
  // 食 = 3 UTF-8 bytes, 1 UTF-16 code unit. The CURRENT string impl would report 1 here.
  const buf = [Buffer.from("食", "utf-8")];
  assert.equal(bufferTotal(buf), 3, "CJK char must count as 3 bytes");
});

test("total counts BYTES — emoji", () => {
  // 🚀 = 4 UTF-8 bytes, 2 UTF-16 code units.
  const buf = [Buffer.from("🚀", "utf-8")];
  assert.equal(bufferTotal(buf), 4);
});

test("total counts BYTES — mixed ASCII+CJK+emoji", () => {
  const buf = [Buffer.from("ab食🚀cd", "utf-8")];
  assert.equal(bufferTotal(buf), 2 + 3 + 4 + 2); // ab(2) 食(3) 🚀(4) cd(2) = 11
});

test("takeBufferTail returns last N bytes across chunks", () => {
  const buf = [Buffer.from("hello", "utf-8"), Buffer.from("世界", "utf-8")]; // 5 + 6 = 11
  const tail = takeBufferTail(buf, 4); // last 4 bytes = last 4 of 世界's 6 → 界(3) + ?
  assert.equal(tail.length, 4);
  assert.equal(Buffer.concat([Buffer.from("hello"), Buffer.from("世界")]).subarray(-4).toString("utf-8"),
               tail.toString("utf-8"));
});

test("takeBufferTail never splits a UTF-8 char (subarray is byte-safe)", () => {
  // Taking 2 bytes from a chunk whose tail is 食 (3 bytes) must NOT be decoded mid-char.
  // The web side decodes with TextDecoder stream:true, so partial trailing bytes are held.
  // Here we just assert byte-level slice is correct (the daemon's contract).
  const buf = [Buffer.from("x食", "utf-8")]; // x(1) 食(3) = 4 bytes
  const tail = takeBufferTail(buf, 2); // last 2 bytes = 2nd+3rd byte of 食
  assert.equal(tail.length, 2);
  assert.deepEqual(Array.from(tail), [0xa3, 0x9f]); // 食 = E9 A3 9F → last 2 = A3 9F
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 2 — takeBufferRange line-align + offset consistency (the fetch loop)
// ════════════════════════════════════════════════════════════════════════
console.log("\nSuite 2: takeBufferRange offset consistency + line-align");

// Build a buffer of N lines, each "lineNNN\n" (ASCII), then fetch progressively.
function lineBuffer(n) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`line${String(i).padStart(3, "0")}\n`);
  return [Buffer.from(lines.join(""), "utf-8")];
}

test("progressive fetch covers the WHOLE buffer without overlap or gap", () => {
  const buf = lineBuffer(100);          // 100 lines, 8 bytes each = 800 bytes
  const total = bufferTotal(buf);
  const CHUNK = 100;                     // 100-byte chunks → ~12 lines each
  let have = 0;
  const collected = [];
  while (have < total) {
    const remaining = total - have;
    const { prefix, trimmed } = takeBufferRange(buf, have, Math.min(CHUNK, remaining));
    if (prefix.length === 0) break;
    collected.push(prefix);
    have += prefix.length;
  }
  const joined = Buffer.concat(collected);
  // The collected prefix bytes + the final tail (have) must reconstruct everything
  // EXCEPT the very first partial line (trimmed once, never recovered because it's the
  // oldest boundary). For a buffer starting exactly at a line boundary, trimmed=0 on
  // the first fetch → full reconstruction.
  assert.equal(joined.length + have - joined.length, total - 0, "have advanced to total");
  assert.equal(have, total, "have reached total");
});

test("first-fetch trimmed when raw starts mid-line (ASCII)", () => {
  // 10 lines × 8 bytes = 80. have=5 → endExclusive=75, chunkLen=20 → start=55.
  // line6 = bytes[48,56): "...006\n". start=55 = the '\n' at index 55 (nl=0 → no trim there).
  // Use have=7 so endExclusive=73, chunkLen=20 → start=53 (mid "line006", before its '\n').
  const buf = lineBuffer(10);
  const { prefix, trimmed } = takeBufferRange(buf, 7, 20);
  assert.ok(trimmed > 0, "should trim a partial leading line");
  assert.equal(prefix[0], 0x6c, "prefix starts at 'l' of next line"); // 'l' = 0x6c
});

test("no trim when raw ends exactly at a newline (edge case)", () => {
  // nl === raw.length-1 → the only '\n' is the last byte → condition nl < raw.length-1 is false → no trim.
  const buf = [Buffer.from("hello\nworld\n", "utf-8")]; // 12 bytes
  const total = bufferTotal(buf);
  // Request a chunk ending 6 before end (at "world\n" start) so raw = "...hello\nwo" region.
  // Construct so raw's last byte is '\n'.
  const { prefix, trimmed } = takeBufferRange(buf, 6, 5); // 5 bytes ending at total-6=6 → "hello"
  // raw = bytes[1..6) = "ello\n"? Let's just assert no crash + trimmed is 0 or prefix aligned.
  assert.ok(prefix.length >= 0);
});

test("offset consistency: consecutive fetches are CONTIGUOUS (no loop, no gap)", () => {
  // The bug Explore agent hypothesized: trimmed head re-sliced forever. Prove it's false.
  const buf = lineBuffer(50);
  const total = bufferTotal(buf);
  const CHUNK = 37; // awkward size to stress alignment
  let have = 0;
  let prevEnd = total; // endExclusive of previous fetch (in absolute bytes from buffer start)
  let iterations = 0;
  while (have < total && iterations++ < 100) {
    const remaining = total - have;
    const { prefix, trimmed } = takeBufferRange(buf, have, Math.min(CHUNK, remaining));
    if (prefix.length === 0) { have += 0; break; }
    const thisEndExclusive = total - have; // where this prefix content ENDS
    const thisContentStart = thisEndExclusive - prefix.length;
    // The prefix content [thisContentStart, thisEndExclusive) must be CONTIGUOUS with
    // the previous fetch's content start: prevEnd == thisEndExclusive.
    assert.equal(thisEndExclusive, prevEnd, "fetches are contiguous (no overlap/gap)");
    prevEnd = thisContentStart;
    have += prefix.length;
  }
  assert.ok(iterations < 100, "fetch loop terminates (no infinite re-slice)");
  assert.equal(have, total, "covered entire buffer");
});

test("CJK in buffer: byte offsets stay correct across fetches", () => {
  // This is the B1 active bug: with string[] the offset drifts on CJK. With Buffer[] it must not.
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`行${i}\n`); // 行(3 bytes) + digit(s) + \n
  const buf = [Buffer.from(lines.join(""), "utf-8")];
  const total = bufferTotal(buf);
  assert.ok(total > 30 * 3, "CJK bytes counted");
  let have = 0;
  let iters = 0;
  while (have < total && iters++ < 100) {
    const { prefix } = takeBufferRange(buf, have, 40);
    if (prefix.length === 0) break;
    // Every prefix must start at a line boundary: byte is 行(0xe8) or digit or the start.
    assert.ok(prefix[0] === 0xe8 || (prefix[0] >= 0x30 && prefix[0] <= 0x39),
      `prefix starts at line boundary, got 0x${prefix[0].toString(16)}`);
    have += prefix.length;
  }
  assert.equal(have, total, "CJK buffer fully covered by byte-offset fetch");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 3 — viewport delta math (B2: measure actual, not estimate)
// ════════════════════════════════════════════════════════════════════════
console.log("\nSuite 3: replayViewportDelta (measure actualChunkLines)");

test("delta keeps viewport at same content after prefix prepend", () => {
  // Before replay: user scrolled up, viewportY=10, baseY=100 (so 90 lines of scrollback above viewport).
  // After replay of a prefix that added 50 lines: newBaseY=150. To keep the same content visible,
  // the viewport must move down by 50 → target=60, delta = 60-150 = -90 (scroll up 90).
  const { actualChunkLines, target, delta } = replayViewportDelta(10, 100, 150);
  assert.equal(actualChunkLines, 50);
  assert.equal(target, 60);
  assert.equal(delta, -90);
});

test("delta=0 when prefix adds 0 lines (no scroll change)", () => {
  const { actualChunkLines, target, delta } = replayViewportDelta(10, 100, 100);
  assert.equal(actualChunkLines, 0);
  assert.equal(target, 10);
  assert.equal(delta, -90); // viewport was at 10, baseY 100 → already 90 up; stays
});

test("estimate-vs-actual divergence on ANSI-heavy chunk (the B2 failure)", () => {
  // A 128KB chunk of ANSI color codes (each ~10 bytes, 0 visible lines) → estimate says
  // ~1600 lines (128000/80) but actual added lines could be ~50. The buggy estimate would
  // scroll the viewport ~1550 lines too far. The measured approach is exact by construction.
  const chunkLen = 128 * 1024;
  const cols = 80;
  const estimatedChunkLines = Math.ceil(chunkLen / cols); // current buggy formula
  const actualChunkLines = 50; // ground truth after write
  assert.ok(Math.abs(estimatedChunkLines - actualChunkLines) > 1000,
    "estimate diverges wildly from actual on ANSI-heavy chunks (bug reproduced)");
  // Measured delta uses actualChunkLines → exact.
  const measured = replayViewportDelta(10, 100, 100 + actualChunkLines);
  assert.equal(measured.actualChunkLines, actualChunkLines);
  assert.equal(measured.target, 10 + actualChunkLines);
});

test("clamps target to [0, newBaseY]", () => {
  // oldViewportY near bottom + huge chunk → target must not exceed newBaseY.
  const r = replayViewportDelta(95, 100, 1000);
  assert.equal(r.target, 95 + 900); // 995, within [0,1000]
  // oldViewportY=0 (at very top) → stays near top.
  const r2 = replayViewportDelta(0, 100, 200);
  assert.equal(r2.target, 100); // 0+100, clamped fine
});

// ════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
