// Browser tile grid — same diffing contract as the remote desktop TileManager,
// fed from a decoded CDP JPEG instead of an OS capture.
// Run: node test/browserTileGrid.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  makeGrid, tileChecksum, diffTiles, decodeJpegRaw, buildTilesBatch
} from "../features/browser/browserTileGrid.js";
import { encodeTilesBatch } from "../features/remote/handlers/ScreenHandler.js";

// Raw RGBA canvas helper — deterministic pixel patterns.
function rawCanvas(w, h, fill) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h, channels: 4 };
}

test("makeGrid: geometry with clipped edge tiles", () => {
  const g = makeGrid(720, 480, 128); // 720 = 5×128 + 80; 480 = 3×128 + 96
  assert.equal(g.cols, 6);
  assert.equal(g.rows, 4);
  assert.equal(g.totalTiles, 24);
  assert.deepEqual(g.tileRect(0), { x: 0, y: 0, width: 128, height: 128 });
  const last = g.tileRect(g.totalTiles - 1);
  assert.deepEqual(last, { x: 640, y: 384, width: 80, height: 96 });
});

test("tileChecksum: content hash — stable, same-content tiles equal, mutation moves it", () => {
  const frame = rawCanvas(256, 128, [10, 20, 30]);
  const grid = makeGrid(256, 128, 128);
  const h0 = tileChecksum(frame, 0, grid);
  assert.equal(tileChecksum(frame, 0, grid), h0, "deterministic");
  // Content hash, like remote: position lives in tileIndex, not the hash.
  assert.equal(tileChecksum(frame, 1, grid), h0, "same content ⇒ same hash");
  const mutated = rawCanvas(256, 128, [10, 20, 30]);
  mutated.data.fill(200, 0, 128 * 4); // paint inside tile 0 only
  assert.notEqual(tileChecksum(mutated, 0, grid), h0);
});

test("diffTiles: first frame all, identical frame none, small edit = covering tiles only", () => {
  const frame = rawCanvas(256, 256, [1, 2, 3]);
  const grid = makeGrid(256, 256, 128);
  const first = diffTiles(null, frame, grid);
  assert.equal(first.changed.length, 4);
  assert.equal(first.hashes.size, 4);

  const same = diffTiles(first.hashes, frame, grid);
  assert.equal(same.changed.length, 0, "identical frame must send nothing");

  const edit = rawCanvas(256, 256, [1, 2, 3]);
  // One 10×10 blot at (130, 5) — inside tile 1 only (x 128..255, y 0..127).
  for (let y = 5; y < 15; y++) {
    for (let x = 130; x < 140; x++) {
      const at = (y * 256 + x) * 4;
      edit.data[at] = 255; edit.data[at + 1] = 0; edit.data[at + 2] = 0;
    }
  }
  const partial = diffTiles(first.hashes, edit, grid);
  assert.deepEqual(partial.changed, [1], "only the covering tile changes");
});

test("decodeJpegRaw → buildTilesBatch → encodeTilesBatch wire roundtrip", async () => {
  const jpeg = await sharp({
    create: { width: 260, height: 130, channels: 3, background: { r: 90, g: 120, b: 200 } }
  }).jpeg({ quality: 90 }).toBuffer();
  const raw = await decodeJpegRaw(jpeg);
  assert.equal(raw.width, 260);
  assert.equal(raw.height, 130);
  assert.equal(raw.channels, 4);

  const grid = makeGrid(raw.width, raw.height, 128);
  const diff = diffTiles(null, raw, grid);
  const tiles = await buildTilesBatch(raw, grid, diff.changed, diff.hashes, 85);
  assert.ok(Array.isArray(tiles) && tiles.length === diff.changed.length);
  // Output codec follows REMOTE_CONFIG.pipeline.tileFormat (webp on mac, jpeg on win).
  const head = tiles[0].imageBuffer.subarray(0, 4).toString("latin1");
  assert.ok(head === "RIFF" || (tiles[0].imageBuffer[0] === 0xff && tiles[0].imageBuffer[1] === 0xd8), `tile payload is webp/jpeg, got ${head}`);

  const batch = encodeTilesBatch(tiles, 1234);
  const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  assert.equal(dv.getUint32(0, true), tiles.length, "tileCount header");
  assert.equal(dv.getFloat64(4, false), 1234, "timestamp header");
  // First tile header: tileIndex/x/y/w/h/imageSize/hash all u32 LE at 12..
  assert.equal(dv.getUint32(12, true), tiles[0].tileIndex);
});

test("buildTilesBatch encodes only the requested indices", async () => {
  const raw = rawCanvas(256, 256, [7, 7, 7]);
  const grid = makeGrid(256, 256, 128);
  const hashes = new Map([[0, 1], [1, 2], [2, 3], [3, 4]]);
  const tiles = await buildTilesBatch(raw, grid, [2], hashes, 85);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].tileIndex, 2);
  assert.deepEqual([tiles[0].x, tiles[0].y, tiles[0].width, tiles[0].height], [0, 128, 128, 128]);
});
