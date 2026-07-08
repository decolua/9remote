import assert from "node:assert";
import sharp from "sharp";

// Mirror the merged scale<1 pipeline from TileManager.compressTileImage
const width = 128;
const height = 128;
const channels = 4;
const quality = 50;
const scale = 0.65;
const targetW = Math.max(1, Math.floor(width * scale));
const targetH = Math.max(1, Math.floor(height * scale));

// Synthetic RGBA raw buffer
const raw = Buffer.alloc(width * height * channels, 128);

const jpeg = await sharp(raw, { raw: { width, height, channels } })
  .resize(targetW, targetH, { kernel: "lanczos3", fastShrinkOnLoad: false })
  .jpeg({ quality })
  .toBuffer();

// JPEG SOI marker 0xFFD8
assert.ok(jpeg.length > 0, "empty jpeg");
assert.strictEqual(jpeg[0], 0xff, "byte0 must be 0xFF (JPEG SOI)");
assert.strictEqual(jpeg[1], 0xd8, "byte1 must be 0xD8 (JPEG SOI)");

// Confirm decoded dimensions match the resized target
const meta = await sharp(jpeg).metadata();
assert.strictEqual(meta.width, targetW, `width ${meta.width} != ${targetW}`);
assert.strictEqual(meta.height, targetH, `height ${meta.height} != ${targetH}`);

console.log(`OK C9 — jpeg SOI ok, dims=${meta.width}x${meta.height} (target ${targetW}x${targetH}), bytes=${jpeg.length}`);
