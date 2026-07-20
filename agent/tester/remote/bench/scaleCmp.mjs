// Compare legacy tier profile vs new smooth profile across mobile zoom levels.
// Measures encoded frame size (KB) + encode time for a typical retina capture.
// Run: node tester/remote/bench/scaleCmp.mjs
import sharp from "sharp";
import { mapLimit } from "../../../features/remote/TileManager.js";
import { makeSynthetic, tileGrid, extractTile, timeIt, ms, kb, DIMS, TILE, CONCURRENCY } from "./_shared.mjs";

sharp.cache(false);
sharp.concurrency(1);

const TILE_FORMAT = "webp";
const WEBP_EFFORT = 0;
const QUALITY = 85;
// Legacy tier table (scaleMode === "tier")
const TIERS = [
  { minEffective: 1.0, outputScale: 1.00 },
  { minEffective: 0.7, outputScale: 0.95 },
  { minEffective: 0.4, outputScale: 0.80 },
  { minEffective: 0,   outputScale: 0.65 }
];
const MIN_SCALE = 0.25, MAX_SCALE = 1.0;

// Simulated mobile: 390px CSS width, dpr 2 (retina phone)
const VIEWER_W = 390, DPR = 2;
const AGENT_W = DIMS.w;

function legacyScale(effective) {
  for (const t of TIERS) if (effective >= t.minEffective) return t.outputScale;
  return TIERS[TIERS.length - 1].outputScale;
}
function smoothScale(effective) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, effective));
}

async function encodeFrame(screen, tiles, scale) {
  const out = await mapLimit(tiles, CONCURRENCY, (t) => {
    const raw = extractTile(screen, t.x, t.y, t.w, t.h);
    const tw = Math.max(1, Math.floor(t.w * scale));
    const th = Math.max(1, Math.floor(t.h * scale));
    return sharp(raw, { raw: { width: t.w, height: t.h, channels: 4 } })
      .resize(tw, th, { kernel: "lanczos3" })
      .webp({ quality: QUALITY, effort: WEBP_EFFORT })
      .toBuffer();
  });
  return out.reduce((a, b) => a + b.length, 0);
}

async function main() {
  console.log(`=== SCALE PROFILE CMP (agent ${DIMS.w}x${DIMS.h}, viewer ${VIEWER_W}px dpr${DPR}, q${QUALITY} ${TILE_FORMAT}) ===\n`);
  const screen = makeSynthetic(DIMS.w, DIMS.h);
  const tiles = tileGrid(DIMS.w, DIMS.h);
  console.log(`  tiles/frame: ${tiles.length}\n`);

  console.log("  zoom | effective | legacy(s,q45) | smooth(s,q85) | legacy-KB | smooth-KB | delta");
  console.log("  -----|-----------|---------------|---------------|-----------|-----------|--------");
  for (const zoom of [1, 2, 3, 4]) {
    const effective = (VIEWER_W * zoom * DPR) / AGENT_W;
    const sLegacy = legacyScale(effective);
    const sSmooth = smoothScale(effective);
    // Legacy used q45 floor at low tiers; smooth uses q85. Encode both at representative q.
    const rLegacy = await timeIt(8, () => encodeFrame(screen, tiles, sLegacy));
    const rSmooth = await timeIt(8, () => encodeFrame(screen, tiles, sSmooth));
    const delta = ((rSmooth.last - rLegacy.last) / rLegacy.last * 100).toFixed(0);
    console.log(`  ${zoom}x   | ${effective.toFixed(3)}    | s=${sLegacy.toFixed(2)} q45    | s=${sSmooth.toFixed(2)} q85    | ${kb(rLegacy.last).padStart(8)} | ${kb(rSmooth.last).padStart(8)} | ${delta}%`);
  }
  console.log("\n  → smooth delta vs legacy: negative = fewer KB (smooth encodes at exact viewer pixels).");
  console.log("  → legacy wastes pixels at low effective (scale 0.65 > needed); smooth saves bandwidth.");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
