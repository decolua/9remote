// Tests for toReplayChunks — splits a terminal mirror into byte-bounded chunks
// so xterm.js parses big replays across yields (keeps main thread responsive on
// scroll-up history fetch). Run: node web/test/replayChunks.test.mjs
import assert from "node:assert/strict";
import { toReplayChunks } from "../features/terminal/lib/replayChunks.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const enc = (s) => new TextEncoder().encode(s);
const concatBytes = (chunks) => {
  let total = 0;
  for (const c of chunks) total += c instanceof Uint8Array ? c.length : Buffer.byteLength(c, "utf-8");
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    if (c instanceof Uint8Array) { out.set(c, off); off += c.length; }
    else { const b = enc(c); out.set(b, off); off += b.length; }
  }
  return out;
};

test("empty mirror → empty array", () => {
  assert.deepEqual(toReplayChunks([], 32768), []);
});

test("single small string → one Uint8Array with same bytes", () => {
  const out = toReplayChunks(["hello"], 32768);
  assert.equal(out.length, 1);
  assert.ok(out[0] instanceof Uint8Array);
  assert.deepEqual(Array.from(out[0]), Array.from(enc("hello")));
});

test("single small Uint8Array → one Uint8Array with same bytes", () => {
  const b = enc("hello");
  const out = toReplayChunks([b], 32768);
  assert.equal(out.length, 1);
  assert.ok(out[0] instanceof Uint8Array);
  assert.deepEqual(Array.from(out[0]), Array.from(b));
});

test("chunk larger than maxBytes → split into bounded pieces", () => {
  const big = "x".repeat(1000);
  const out = toReplayChunks([big], 100);
  assert.ok(out.length >= 10, `expected >=10 chunks, got ${out.length}`);
  for (const c of out) {
    const len = c instanceof Uint8Array ? c.length : Buffer.byteLength(c, "utf-8");
    assert.ok(len <= 100, `chunk len ${len} > maxBytes 100`);
  }
});

test("byte order preserved (string split)", () => {
  const src = "ABCDEFGHIJ";
  const out = toReplayChunks([src], 3);
  assert.equal(concatBytes(out).join(""), enc(src).join(""));
});

test("byte order preserved (mixed Uint8Array + string)", () => {
  const mirror = [enc("AAA"), "BBB", enc("CCC"), "DDD"];
  const expected = concatBytes(mirror);
  const out = toReplayChunks(mirror, 4);
  assert.deepEqual(concatBytes(out), expected);
});

test("multiple small chunks coalesced up to maxBytes", () => {
  const mirror = ["ab", "cd", "ef", "gh"];
  const out = toReplayChunks(mirror, 4);
  // Each pair fits in 4 bytes → should coalesce into fewer chunks
  assert.ok(out.length <= 2, `expected <=2 chunks, got ${out.length}`);
  assert.deepEqual(concatBytes(out), concatBytes(mirror));
});

test("total byte length equals input total", () => {
  const mirror = [enc("X".repeat(50)), "Y".repeat(60), enc("Z".repeat(70))];
  const inTotal = concatBytes(mirror).length;
  const out = toReplayChunks(mirror, 32);
  assert.equal(concatBytes(out).length, inTotal);
});

test("UTF-8 multibyte bytes preserved across boundary (no decode, byte-split ok)", () => {
  // é = 0xC3 0xA9, emoji 😀 = F0 9F 98 80 — byte slicing may split a codepoint,
  // but xterm preserves ANSI/UTF-8 state across writes so order is byte-exact.
  const src = "café😀测试";
  const out = toReplayChunks([src], 3);
  assert.deepEqual(concatBytes(out), enc(src));
});

test("maxBytes floor of 1 → never infinite loop, bytes intact", () => {
  const src = "hello world";
  const out = toReplayChunks([src], 1);
  assert.deepEqual(concatBytes(out), enc(src));
  for (const c of out) {
    const len = c instanceof Uint8Array ? c.length : Buffer.byteLength(c, "utf-8");
    assert.ok(len === 1, `expected 1-byte chunks, got ${len}`);
  }
});

test("Uint8Array + string interleave with small maxBytes keeps byte order", () => {
  const mirror = [enc("123"), "45", enc("6"), "789"];
  const out = toReplayChunks(mirror, 2);
  assert.deepEqual(concatBytes(out), concatBytes(mirror));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
