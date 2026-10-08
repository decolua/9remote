import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_FRAME_MAGIC, BROWSER_HEADER_SIZE, BROWSER_FLAG_TILES,
  encodeBrowserFrame, decodeBrowserFrame, browserFrameChunks
} from "../features/browser/browserFrame.js";

const META = { deviceWidth: 1280, deviceHeight: 800, scrollX: 3, scrollY: 7, scale: 1, offsetTop: 0 };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

test("encode/decode roundtrip single chunk", () => {
  const chunk = encodeBrowserFrame({ targetId: "abc123", seq: 5, meta: META, payload: JPEG });
  const dec = decodeBrowserFrame(chunk);
  assert.ok(dec);
  assert.equal(dec.targetId, "abc123");
  assert.equal(dec.seq, 5);
  assert.deepEqual(dec.meta, META);
  assert.deepEqual(dec.payload, JPEG);
  assert.equal(dec.chunkIdx, 0);
  assert.equal(dec.chunkCount, 1);
});

test("decode returns null on foreign frames (file/mobile)", () => {
  assert.equal(decodeBrowserFrame(new Uint8Array(4)), null);
  const notOurs = new Uint8Array(64);
  new DataView(notOurs.buffer).setUint32(0, 0xffffffff); // mobile magic
  assert.equal(decodeBrowserFrame(notOurs), null);
  const fileLike = new Uint8Array(64);
  new DataView(fileLike.buffer).setUint32(0, 42); // a file-transfer uploadId
  assert.equal(decodeBrowserFrame(fileLike), null);
});

test("browserFrameChunks splits oversize payloads and every chunk decodes", () => {
  const big = new Uint8Array(200).map((_, i) => i & 0xff);
  const chunks = browserFrameChunks({ targetId: "t1", seq: 9, meta: META, payload: big }, 64);
  assert.ok(chunks.length >= 2);
  const seen = new Set();
  for (const c of chunks) {
    const dec = decodeBrowserFrame(c);
    assert.ok(dec, "every chunk decodes");
    assert.equal(dec.seq, 9);
    assert.equal(dec.targetId, "t1");
    assert.deepEqual(dec.meta, META);
    seen.add(dec.chunkIdx);
    assert.ok(dec.chunkIdx < dec.chunkCount);
  }
  assert.equal(seen.size, chunks.length);
  // Reassemble in order → original bytes
  const joined = new Uint8Array(big.byteLength);
  let at = 0;
  for (const c of chunks) {
    const dec = decodeBrowserFrame(c);
    joined.set(dec.payload, at);
    at += dec.payload.byteLength;
  }
  assert.deepEqual(joined, big);
});

test("flags byte rides the header: full-jpeg default 0, tile batch 1", () => {
  const full = encodeBrowserFrame({ targetId: "t", seq: 1, meta: META, payload: JPEG });
  assert.equal(decodeBrowserFrame(full).flags, 0);
  const tiled = encodeBrowserFrame({ targetId: "t", seq: 1, meta: META, payload: JPEG, flags: BROWSER_FLAG_TILES });
  assert.equal(decodeBrowserFrame(tiled).flags, 1);
});

test("malformed header fields are rejected, not thrown", () => {
  const chunk = encodeBrowserFrame({ targetId: "t", seq: 1, meta: META, payload: JPEG });
  const evil = new Uint8Array(chunk);
  // targetIdLen beyond buffer (offset 12)
  evil[12] = 200;
  assert.equal(decodeBrowserFrame(evil), null);
  const evil2 = new Uint8Array(chunk);
  // metaLen high byte → metaLen beyond buffer (u16 at offset 14)
  evil2[14] = 0x7f;
  assert.equal(decodeBrowserFrame(evil2), null);
});
