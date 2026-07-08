// T1 + T6: encoder comparison — JPEG(mozjpeg) vs WebP(effort tiers) vs AVIF.
// Native SIMD via sharp/libvips/highway. Measures per-frame time + output size.
// Run: node tester/remote/bench/encoders.mjs
import sharp from "sharp";
import { mapLimit } from "../../../features/remote/TileManager.js";
import { makeSynthetic, tileGrid, extractTile, timeIt, ms, kb, DIMS, TILE, CONCURRENCY } from "./_shared.mjs";

sharp.cache(false);
sharp.concurrency(1);

const ITER = 30;
const Q = 50;

const jpeg = (raw, w, h) => sharp(raw, { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: Q }).toBuffer();
const webp = (eff) => (raw, w, h) => sharp(raw, { raw: { width: w, height: h, channels: 4 } }).webp({ quality: Q, effort: eff }).toBuffer();
const avif = (raw, w, h) => sharp(raw, { raw: { width: w, height: h, channels: 4 } }).avif({ quality: Q, effort: 0 }).toBuffer();

async function main() {
  console.log(`=== T1/T6 ENCODERS (ITER=${ITER}, ${DIMS.w}x${DIMS.h}, tile=${TILE}, conc=${CONCURRENCY}, q=${Q}) ===\n`);
  const screen = makeSynthetic(DIMS.w, DIMS.h);
  const tiles = tileGrid(DIMS.w, DIMS.h).map((t) => ({ ...t, raw: extractTile(screen, t.x, t.y, t.w, t.h) }));
  console.log(`grid: ${tiles.length} tiles\n`);

  const variants = [
    ["JPEG mozjpeg", jpeg],
    ["WebP eff=0", webp(0)],
    ["WebP eff=2", webp(2)],
    ["WebP eff=4", webp(4)],
    ["AVIF eff=0", avif]
  ];

  const base = { time: null, size: null };
  for (const [name, fn] of variants) {
    const r = await timeIt(ITER, () => mapLimit(tiles, CONCURRENCY, (t) => fn(t.raw, t.w, t.h)));
    const size = r.last.reduce((a, b) => a + b.length, 0);
    if (base.time === null) { base.time = r.stat.p50; base.size = size; }
    const dt = ((r.stat.p50 / base.time - 1) * 100).toFixed(0);
    const dz = ((size / base.size - 1) * 100).toFixed(0);
    console.log(`  ${name.padEnd(14)}: ${ms(r.stat)} ms | ${kb(size).padStart(9)} | time ${dt >= 0 ? "+" : ""}${dt}% size ${dz >= 0 ? "+" : ""}${dz}%`);
  }
  console.log("\n(baseline = first row JPEG; negative = better)");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
