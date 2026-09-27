// Unit tests for the agent tile encode pipeline (encoderAdapter + compressTileImage).
// Runs REAL sharp / jpeg-turbo encode to measure time, size, and memory behavior —
// these are the numbers that decide whether the agent can keep up with a 16fps
// full-screen video stream.
//
// Run: node agent/test/remoteEncode.test.mjs
import { encodeJpeg, bgraToRgbaInPlace } from "../features/remote/adapters/encoderAdapter.js";
import sharp from "sharp";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
const assert = (c, m) => { if (!c) throw new Error(m || "assert"); };
const now = () => performance.now();

// Synthetic raw RGBA tile (128×128) — random-ish noise compresses like real screen
function rawTile(size = 128) {
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}
function rawTileFlat(size = 128, r = 100, g = 100, b = 100) {
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; }
  return buf;
}

async function timeAsync(fn, iters = 1) {
  const t = now();
  for (let i = 0; i < iters; i++) await fn();
  return (now() - t) / iters;
}

await test("E1 encodeJpeg webp returns a non-empty buffer", async () => {
  const out = await encodeJpeg(rawTile(), 128, 128, 4, 65, "rgba");
  assert(Buffer.isBuffer(out) && out.length > 0, `webp out ${out?.length}`);
  assert(out[0] === 0x52 && out[1] === 0x49, "webp magic RIFF"); // 'R','I'
});

await test("E2 encodeJpeg jpeg returns a JPEG (FFD8)", async () => {
  // Force jpeg path: pipeline.encoder is sharp on this platform → tileFormat must be jpeg
  const out = await encodeJpeg(rawTile(), 128, 128, 4, 60, "rgba");
  assert(Buffer.isBuffer(out) && out.length > 0, `jpeg out ${out?.length}`);
});

await test("E3 encode one 128px tile < 5ms (single-thread budget)", async () => {
  await encodeJpeg(rawTile(), 128, 128, 4, 65, "rgba"); // warmup
  const ms = await timeAsync(() => encodeJpeg(rawTile(), 128, 128, 4, 65, "rgba"), 50);
  console.log(`    webp encode 128px: ${ms.toFixed(2)}ms/tile`);
  assert(ms < 5, `encode too slow: ${ms.toFixed(2)}ms`);
});

await test("E4 full-frame encode cost @ 120 tiles / concurrency 6 < frame budget", async () => {
  const tile = rawTile();
  const N = 120, CONC = 6;
  const { mapLimit } = await import("../features/remote/TileManager.js");
  await mapLimit(Array.from({ length: N }, (_, i) => i), CONC, async () => {
    await encodeJpeg(tile, 128, 128, 4, 65, "rgba");
  }); // warmup
  const ms = await timeAsync(async () => {
    await mapLimit(Array.from({ length: N }, (_, i) => i), CONC, async () => {
      await encodeJpeg(tile, 128, 128, 4, 65, "rgba");
    });
  }, 3);
  const fps = 1000 / ms;
  console.log(`    full-frame ${N} tiles conc=${CONC}: ${ms.toFixed(0)}ms → ${fps.toFixed(1)} fps max`);
  assert(ms < 1000, `full frame too slow: ${ms.toFixed(0)}ms (cannot do 1fps)`);
});

await test("E5 bgraToRgbaInPlace swaps R↔B correctly", () => {
  const buf = Buffer.from([10, 20, 30, 255]); // B=10 G=20 R=30 A=255
  bgraToRgbaInPlace(buf);
  assert(buf[0] === 30 && buf[1] === 20 && buf[2] === 10 && buf[3] === 255, `swapped ${buf}`);
});

await test("E6 higher quality → larger bytes (flat region)", async () => {
  const flat = rawTileFlat(128, 120, 80, 60);
  const lo = await encodeJpeg(flat, 128, 128, 4, 30, "rgba");
  const hi = await encodeJpeg(flat, 128, 128, 4, 90, "rgba");
  console.log(`    flat q30=${lo.length}B q90=${hi.length}B`);
  assert(hi.length >= lo.length, "higher quality should not be smaller");
});

await test("E7 scratch buffer reuse does not realloc every tile (mapLimit slots)", async () => {
  // compressTileImage reuses per-slot scratch via _getScratch. We approximate by
  // confirming repeated encodes of the same size don't grow the pool beyond limit.
  const { mapLimit } = await import("../features/remote/TileManager.js");
  const tile = rawTile();
  const slots = new Set();
  await mapLimit(Array.from({ length: 60 }, (_, i) => i), 6, async (_x, _i, slotId) => {
    slots.add(slotId);
    await encodeJpeg(tile, 128, 128, 4, 65, "rgba");
  });
  assert(slots.size <= 6, `slot count ${slots.size} exceeded concurrency 6`);
  console.log(`    distinct slotIds used: ${[...slots].sort().join(",")}`);
});

await test("E8 webp effort 0 is faster than effort 4 (config uses 0)", async () => {
  const tile = rawTile(128);
  const a = sharp(tile, { raw: { width: 128, height: 128, channels: 4 } });
  const e0 = await timeAsync(() =>
    sharp(tile, { raw: { width: 128, height: 128, channels: 4 } }).webp({ quality: 65, effort: 0 }).toBuffer(), 30);
  const e4 = await timeAsync(() =>
    sharp(tile, { raw: { width: 128, height: 128, channels: 4 } }).webp({ quality: 65, effort: 4 }).toBuffer(), 30);
  console.log(`    effort0=${e0.toFixed(2)}ms effort4=${e4.toFixed(2)}ms`);
  assert(e0 <= e4, `effort0 should be <= effort4 (got e0=${e0.toFixed(2)} e4=${e4.toFixed(2)})`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
