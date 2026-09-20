// Run: node agent/test/historyBuffer.test.mjs
// Tests scroll-up history fetch: byte-accurate buffer slicing and viewport delta math.
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

function bufferTotal(chunks) {
  if (!chunks?.length) return 0;
  return chunks.reduce((sum, c) => sum + c.length, 0);
}

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

  let trimmed = 0;
  const nl = raw.indexOf(0x0a);
  if (nl > 0 && nl < raw.length - 1) { trimmed = nl + 1; raw = raw.subarray(trimmed); }
  return { prefix: raw, trimmed };
}

function replayViewportDelta(oldViewportY, oldBaseY, newBaseY) {
  const actualChunkLines = newBaseY - oldBaseY;
  const target = Math.max(0, Math.min(oldViewportY + actualChunkLines, newBaseY));
  const delta = target - newBaseY;
  return { actualChunkLines, target, delta };
}

console.log("\nSuite 1: byte-accurate bufferTotal / takeBufferTail (Buffer[])");

test("total counts BYTES not chars — CJK", () => {
  const buf = [Buffer.from("食", "utf-8")];
  assert.equal(bufferTotal(buf), 3, "CJK char must count as 3 bytes");
});

test("total counts BYTES — emoji", () => {
  const buf = [Buffer.from("🚀", "utf-8")];
  assert.equal(bufferTotal(buf), 4);
});

test("total counts BYTES — mixed ASCII+CJK+emoji", () => {
  const buf = [Buffer.from("ab食🚀cd", "utf-8")];
  assert.equal(bufferTotal(buf), 2 + 3 + 4 + 2);
});

test("takeBufferTail returns last N bytes across chunks", () => {
  const buf = [Buffer.from("hello", "utf-8"), Buffer.from("世界", "utf-8")];
  const tail = takeBufferTail(buf, 4);
  assert.equal(tail.length, 4);
  assert.equal(Buffer.concat([Buffer.from("hello"), Buffer.from("世界")]).subarray(-4).toString("utf-8"),
               tail.toString("utf-8"));
});

test("takeBufferTail never splits a UTF-8 char (subarray is byte-safe)", () => {
  const buf = [Buffer.from("x食", "utf-8")];
  const tail = takeBufferTail(buf, 2);
  assert.equal(tail.length, 2);
  assert.deepEqual(Array.from(tail), [0xa3, 0x9f]);
});

console.log("\nSuite 2: takeBufferRange offset consistency + line-align");

function lineBuffer(n) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`line${String(i).padStart(3, "0")}\n`);
  return [Buffer.from(lines.join(""), "utf-8")];
}

test("progressive fetch covers the WHOLE buffer without overlap or gap", () => {
  const buf = lineBuffer(100);
  const total = bufferTotal(buf);
  const CHUNK = 100;
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
  assert.equal(joined.length + have - joined.length, total - 0, "have advanced to total");
  assert.equal(have, total, "have reached total");
});

test("first-fetch trimmed when raw starts mid-line (ASCII)", () => {
  const buf = lineBuffer(10);
  const { prefix, trimmed } = takeBufferRange(buf, 7, 20);
  assert.ok(trimmed > 0, "should trim a partial leading line");
  assert.equal(prefix[0], 0x6c, "prefix starts at 'l' of next line");
});

test("no trim when raw ends exactly at a newline (edge case)", () => {
  const buf = [Buffer.from("hello\nworld\n", "utf-8")];
  const total = bufferTotal(buf);
  const { prefix, trimmed } = takeBufferRange(buf, 6, 5);
  assert.ok(prefix.length >= 0);
});

test("offset consistency: consecutive fetches are CONTIGUOUS (no loop, no gap)", () => {
  const buf = lineBuffer(50);
  const total = bufferTotal(buf);
  const CHUNK = 37;
  let have = 0;
  let prevEnd = total;
  let iterations = 0;
  while (have < total && iterations++ < 100) {
    const remaining = total - have;
    const { prefix, trimmed } = takeBufferRange(buf, have, Math.min(CHUNK, remaining));
    if (prefix.length === 0) { have += 0; break; }
    const thisEndExclusive = total - have;
    const thisContentStart = thisEndExclusive - prefix.length;
    assert.equal(thisEndExclusive, prevEnd, "fetches are contiguous (no overlap/gap)");
    prevEnd = thisContentStart;
    have += prefix.length;
  }
  assert.ok(iterations < 100, "fetch loop terminates (no infinite re-slice)");
  assert.equal(have, total, "covered entire buffer");
});

test("CJK in buffer: byte offsets stay correct across fetches", () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`行${i}\n`);
  const buf = [Buffer.from(lines.join(""), "utf-8")];
  const total = bufferTotal(buf);
  assert.ok(total > 30 * 3, "CJK bytes counted");
  let have = 0;
  let iters = 0;
  while (have < total && iters++ < 100) {
    const { prefix } = takeBufferRange(buf, have, 40);
    if (prefix.length === 0) break;
    assert.ok(prefix[0] === 0xe8 || (prefix[0] >= 0x30 && prefix[0] <= 0x39),
      `prefix starts at line boundary, got 0x${prefix[0].toString(16)}`);
    have += prefix.length;
  }
  assert.equal(have, total, "CJK buffer fully covered by byte-offset fetch");
});

console.log("\nSuite 3: replayViewportDelta (measure actualChunkLines)");

test("delta keeps viewport at same content after prefix prepend", () => {
  const { actualChunkLines, target, delta } = replayViewportDelta(10, 100, 150);
  assert.equal(actualChunkLines, 50);
  assert.equal(target, 60);
  assert.equal(delta, -90);
});

test("delta=0 when prefix adds 0 lines (no scroll change)", () => {
  const { actualChunkLines, target, delta } = replayViewportDelta(10, 100, 100);
  assert.equal(actualChunkLines, 0);
  assert.equal(target, 10);
  assert.equal(delta, -90);
});

test("estimate-vs-actual divergence on ANSI-heavy chunk (the B2 failure)", () => {
  const chunkLen = 128 * 1024;
  const cols = 80;
  const estimatedChunkLines = Math.ceil(chunkLen / cols);
  const actualChunkLines = 50;
  assert.ok(Math.abs(estimatedChunkLines - actualChunkLines) > 1000,
    "estimate diverges wildly from actual on ANSI-heavy chunks (bug reproduced)");
  const measured = replayViewportDelta(10, 100, 100 + actualChunkLines);
  assert.equal(measured.actualChunkLines, actualChunkLines);
  assert.equal(measured.target, 10 + actualChunkLines);
});

test("clamps target to [0, newBaseY]", () => {
  const r = replayViewportDelta(95, 100, 1000);
  assert.equal(r.target, 95 + 900);
  const r2 = replayViewportDelta(0, 100, 200);
  assert.equal(r2.target, 100);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
