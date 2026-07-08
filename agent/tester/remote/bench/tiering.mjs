// T3: refresh strategy — full-refresh vs changed-only vs focus-region.
// Shows encode cost scales with tiles/frame → focus + changed-only are the real win.
// Run: node tester/remote/bench/tiering.mjs
import sharp from "sharp";
import { mapLimit } from "../../../features/remote/TileManager.js";
import { makeSynthetic, tileGrid, extractTile, timeIt, ms, kb, DIMS, TILE, CONCURRENCY } from "./_shared.mjs";

sharp.cache(false);
sharp.concurrency(1);

const ITER = 20;
const Q = 50;
const jpeg = (raw, w, h) => sharp(raw, { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: Q }).toBuffer();

async function encodeSubset(screen, tiles, subset) {
  const out = await mapLimit(subset, CONCURRENCY, (t) => jpeg(extractTile(screen, t.x, t.y, t.w, t.h), t.w, t.h));
  return out.reduce((a, b) => a + b.length, 0);
}

async function main() {
  console.log(`=== T3 REFRESH STRATEGY (ITER=${ITER}, ${DIMS.w}x${DIMS.h}, tile=${TILE}) ===\n`);
  const screen = makeSynthetic(DIMS.w, DIMS.h);
  const all = tileGrid(DIMS.w, DIMS.h);
  const total = all.length;

  // Scenarios: fraction of tiles changed per frame
  const scenarios = [
    ["full refresh (100%)", all],
    ["scene change (30%)", all.filter((_, i) => i % 10 < 3)],
    ["typing/cursor (5%)", all.filter((_, i) => i % 20 === 0)],
    ["focus region (~15%)", all.filter((t) => t.x < DIMS.w * 0.4 && t.y < DIMS.h * 0.4)]
  ];

  let bytes;
  for (const [name, subset] of scenarios) {
    const r = await timeIt(ITER, async () => { bytes = await encodeSubset(screen, all, subset); });
    console.log(`  ${name.padEnd(22)}: ${subset.length.toString().padStart(3)}/${total} tiles | ${ms(r.stat)} ms | ${kb(bytes)}`);
  }
  console.log("\n  → encode time ∝ tiles/frame. Focus + changed-only already cut most cost.");
  console.log("  → biggest lever after that = per-tile encoder speed (see encoders.mjs / WebP).");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
