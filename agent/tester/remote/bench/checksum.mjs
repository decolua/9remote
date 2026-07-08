// T2: checksum — current byte-scalar sample vs Uint32 word-read variant.
// Both sample every 16px; Uint32 reads 4 bytes per op instead of 4 separate byte loads.
// Run: node tester/remote/bench/checksum.mjs
import { makeSynthetic, tileGrid, timeIt, ms, DIMS, TILE } from "./_shared.mjs";

const ITER = 50;

// Current impl (TileManager.calculateTileChecksumDirect)
function checksumCurrent(s, sx, sy, tw, th) {
  const ch = s.channels, rowBytes = s.width * ch, step = 16;
  let sum = 0;
  for (let y = 0; y < th; y += 4) {
    const ox = ((y >> 2) & 1) * 8;
    const ro = (sy + y) * rowBytes + sx * ch;
    for (let x = ox; x < tw; x += step) {
      const o = ro + x * ch;
      sum += s.buffer[o];
      sum ^= s.buffer[o + 1];
      sum += s.buffer[o + 2] << 1;
      sum ^= s.buffer[o + 3] << 2;
    }
  }
  return sum >>> 0;
}

// Uint32 word read — one 32-bit load per sampled pixel (RGBA packed)
function checksumU32(s, sx, sy, tw, th, u32, wordsPerRow) {
  const step = 16;
  let sum = 0;
  for (let y = 0; y < th; y += 4) {
    const ox = ((y >> 2) & 1) * 8;
    const ro = (sy + y) * wordsPerRow + sx;
    for (let x = ox; x < tw; x += step) {
      const p = u32[ro + x];
      sum = (sum + (p & 0xff)) ^ ((p >> 8) & 0xff);
      sum = (sum + (((p >> 16) & 0xff) << 1)) ^ (((p >> 24) & 0xff) << 2);
    }
  }
  return sum >>> 0;
}

async function main() {
  console.log(`=== T2 CHECKSUM (ITER=${ITER}, ${DIMS.w}x${DIMS.h}, tile=${TILE}) ===\n`);
  const screen = makeSynthetic(DIMS.w, DIMS.h);
  const tiles = tileGrid(DIMS.w, DIMS.h);
  const u32 = new Uint32Array(screen.buffer.buffer, screen.buffer.byteOffset, screen.buffer.length >> 2);
  const wordsPerRow = screen.width;
  console.log(`grid: ${tiles.length} tiles\n`);

  const cur = await timeIt(ITER, () => { for (const t of tiles) checksumCurrent(screen, t.x, t.y, t.w, t.h); });
  const opt = await timeIt(ITER, () => { for (const t of tiles) checksumU32(screen, t.x, t.y, t.w, t.h, u32, wordsPerRow); });

  console.log(`  current (byte) : ${ms(cur.stat)} ms`);
  console.log(`  Uint32 (word)  : ${ms(opt.stat)} ms`);
  const gain = ((1 - opt.stat.p50 / cur.stat.p50) * 100).toFixed(0);
  console.log(`\n  → Uint32 ${gain >= 0 ? gain + "% faster" : Math.abs(gain) + "% slower"} (p50)`);
  console.log("  NOTE: checksum already <1ms/frame — not the bottleneck. Encode dominates.");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
