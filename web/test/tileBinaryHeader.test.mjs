// Characterization tests for the tile frame header parser extracted from
// RemoteDesktop (it was duplicated verbatim across the v1 and v2 listeners).
// The mixed endianness is the agent's wire format — a flip silently corrupts
// every latency number in the benchmark, so it is pinned here.
// Run: node --import ./test/loader-alias.mjs web/test/tileBinaryHeader.test.mjs
import assert from "node:assert/strict";
import { parseTileHeader, tileStatsFrom, toArrayBuffer } from "../features/remote/lib/tileBinaryHeader.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

function frame(tileCount, timestamp, extra = 0) {
  const ab = new ArrayBuffer(12 + extra);
  const v = new DataView(ab);
  v.setUint32(0, tileCount, true);  // little-endian
  v.setFloat64(4, timestamp, false); // big-endian
  return ab;
}

test("parses tileCount little-endian and timestamp big-endian", () => {
  const ts = 1731412345678.5;
  const r = parseTileHeader(frame(7, ts));
  assert.equal(r.tileCount, 7);
  assert.equal(r.timestamp, ts);
  assert.equal(r.bytes, 12);
});

test("endianness is not symmetric — a flipped read would be wrong", () => {
  const ab = frame(1, 0);
  // Reading tileCount as big-endian gives a wildly different number: proof the
  // little-endian read is load-bearing, not incidental.
  assert.notEqual(new DataView(ab).getUint32(0, false), 1);
});

test("accepts a TypedArray view as well as a raw ArrayBuffer", () => {
  const ab = frame(3, 1000);
  const view = new Uint8Array(ab);
  assert.deepEqual(parseTileHeader(view), parseTileHeader(ab));
  assert.equal(toArrayBuffer(view), ab);
  assert.equal(toArrayBuffer(ab), ab);
});

test("bytes reports the FULL frame size, not just the header", () => {
  assert.equal(parseTileHeader(frame(2, 1, 5000)).bytes, 5012);
});

test("short buffer degrades to count 0 + local clock (never throws)", () => {
  const r = parseTileHeader(new ArrayBuffer(8), 999);
  assert.equal(r.tileCount, 0);
  assert.equal(r.timestamp, 999, "falls back to the injected clock");
  assert.equal(r.bytes, 8);
});

test("null / undefined / garbage payload is survivable", () => {
  for (const bad of [null, undefined, {}, 0]) {
    const r = parseTileHeader(bad, 42);
    assert.equal(r.tileCount, 0);
    assert.equal(r.timestamp, 42);
    assert.equal(r.bytes, 0);
  }
});

test("tileStatsFrom produces the shape trackTilesReceived expects", () => {
  const ts = 1700000000000;
  const s = tileStatsFrom(frame(4, ts, 100));
  assert.equal(Array.isArray(s.tiles), true);
  assert.equal(s.tiles.length, 4, "tiles.length is what the benchmark counts");
  assert.equal(s.timestamp, ts);
  assert.equal(s.bytes, 112);
});

test("zero-tile frame is valid (keepalive / no dirty tiles)", () => {
  const s = tileStatsFrom(frame(0, 5));
  assert.equal(s.tiles.length, 0);
  assert.equal(s.timestamp, 5);
});

test("large tile counts survive the u32 range", () => {
  assert.equal(parseTileHeader(frame(4294967295, 1)).tileCount, 4294967295);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
