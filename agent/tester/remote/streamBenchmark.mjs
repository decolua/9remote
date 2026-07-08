// Stream pipeline BASELINE benchmark — capture→checksum→extract→encode→batch.
// Standalone. Not imported by app. robotjs avoided (segfaults in CLI); capture via
// node-screenshots (real, cross-platform) + synthetic buffer for deterministic encode/checksum.
// Run: node agent/tester/remote/streamBenchmark.mjs
import sharp from "sharp";
import { performance } from "perf_hooks";
import { encodeTilesBatch } from "../../features/remote/handlers/ScreenHandler.js";
import { mapLimit } from "../../features/remote/TileManager.js";

sharp.cache(false);
sharp.concurrency(1);

const ITER = 30;
const CAP_ITER = 3;           // capture is slow via CLI (permission per call); fewer samples
const TILE = 128;              // matches darwin tileSize
const CONCURRENCY = 6;         // matches REMOTE_CONFIG.pipeline.tileConcurrency
const JPEG_Q = 50;
const WEBP_Q = 50;

// ─── stats helpers ───────────────────────────────────────────────
const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { avg: sum / s.length, p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
};
const ms = (o) => `avg=${o.avg.toFixed(2)} p50=${o.p50.toFixed(2)} p95=${o.p95.toFixed(2)} max=${o.max.toFixed(2)}`;
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

// ─── synthetic screen buffer (deterministic, ~photo-like noise) ──
function makeSynthetic(width, height, channels = 4) {
  const buf = Buffer.allocUnsafe(width * height * channels);
  // Desktop-like content: smooth gradients + solid blocks + light noise.
  // Represents real UI (compressible) far better than pure noise, so JPEG/WebP/AVIF
  // ratios reflect production, not worst-case entropy.
  let seed = 0x12345678;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      // block regions (like windows/panels) + gradient + tiny dither
      const block = (((x >> 7) + (y >> 7)) & 1) * 40;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const dither = (seed >> 20) & 7;
      buf[i] = (80 + block + ((x * 120 / width) | 0) + dither) & 0xff;       // R
      buf[i + 1] = (90 + block + ((y * 100 / height) | 0) + dither) & 0xff;  // G
      buf[i + 2] = (120 + block + dither) & 0xff;                            // B
      buf[i + 3] = 255;                                                       // A
    }
  }
  return { buffer: buf, width, height, channels };
}

// ─── checksum (copy of TileManager.calculateTileChecksumDirect logic) ──
function checksumTile(screenData, startX, startY, tileW, tileH) {
  const channels = screenData.channels;
  const screenRowBytes = screenData.width * channels;
  const sampleStep = 16;
  let sum = 0;
  for (let y = 0; y < tileH; y += 4) {
    const offsetX = ((y >> 2) & 1) * 8;
    const rowOffset = (startY + y) * screenRowBytes + startX * channels;
    for (let x = offsetX; x < tileW; x += sampleStep) {
      const offset = rowOffset + x * channels;
      sum += screenData.buffer[offset];
      sum ^= screenData.buffer[offset + 1];
      sum += screenData.buffer[offset + 2] << 1;
      sum ^= screenData.buffer[offset + 3] << 2;
    }
  }
  return sum >>> 0;
}

function extractTile(screenData, startX, startY, tileW, tileH) {
  const channels = screenData.channels;
  const rowBytes = tileW * channels;
  const tileBuffer = Buffer.allocUnsafe(tileW * tileH * channels);
  for (let y = 0; y < tileH; y++) {
    const srcOffset = ((startY + y) * screenData.width + startX) * channels;
    screenData.buffer.copy(tileBuffer, y * rowBytes, srcOffset, srcOffset + rowBytes);
  }
  return tileBuffer;
}

// BGRA→RGBA swap (sharp needs RGBA); synthetic treated as RGBA already
function encodeJPEG(raw, w, h) {
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: JPEG_Q }).toBuffer();
}
function encodeWEBP(raw, w, h) {
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).webp({ quality: WEBP_Q, effort: 0 }).toBuffer();
}
function encodeAVIF(raw, w, h) {
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).avif({ quality: WEBP_Q, effort: 0 }).toBuffer();
}

// ─── tile grid over a screen ─────────────────────────────────────
function tileGrid(width, height) {
  const cols = Math.ceil(width / TILE);
  const rows = Math.ceil(height / TILE);
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * TILE, y = r * TILE;
      const w = Math.min(TILE, width - x), h = Math.min(TILE, height - y);
      tiles.push({ x, y, w, h });
    }
  }
  return tiles;
}

async function main() {
  console.log(`=== Stream BASELINE benchmark (ITER=${ITER}, tile=${TILE}, concurrency=${CONCURRENCY}) ===\n`);

  // ── 1. Real capture via node-screenshots (opt-in: CLI capture is ~30s/call due to TCC) ──
  let capW = 2940, capH = 1912;
  console.log("--- 1. CAPTURE (node-screenshots, real screen) ---");
  if (process.env.BENCH_CAPTURE === "1") {
    try {
      const ns = await import("node-screenshots");
      const Monitor = ns.Monitor || ns.default?.Monitor;
      const m = Monitor.all()[0];
      const warm = m.captureImageSync();
      capW = warm.width; capH = warm.height;
      const capTimes = [];
      for (let i = 0; i < CAP_ITER; i++) {
        const t = performance.now();
        const img = m.captureImageSync();
        const raw = img.toRawSync ? img.toRawSync() : img.rawSync();
        capTimes.push(performance.now() - t);
        if (i === 0) console.log(`  frame: ${img.width}x${img.height} ${(raw.length / 1048576).toFixed(1)}MB`);
      }
      console.log(`  capture time (${CAP_ITER} samples): ${ms(stat(capTimes))} ms`);
    } catch (e) {
      console.log(`  SKIP capture (${e.message}) — synthetic dims ${capW}x${capH}`);
    }
  } else {
    console.log(`  SKIPPED (set BENCH_CAPTURE=1 to measure; CLI capture ~30s/call via TCC). dims ${capW}x${capH}`);
  }

  // ── synthetic screen for deterministic stages ──
  const screen = makeSynthetic(capW, capH);
  const tiles = tileGrid(capW, capH);
  console.log(`\n  grid: ${tiles.length} tiles @ ${TILE}px over ${capW}x${capH}`);

  // ── 2. CHECKSUM full screen ──
  console.log("\n--- 2. CHECKSUM (all tiles, direct sample) ---");
  {
    const times = [];
    for (let i = 0; i < ITER; i++) {
      const t = performance.now();
      for (const tl of tiles) checksumTile(screen, tl.x, tl.y, tl.w, tl.h);
      times.push(performance.now() - t);
    }
    console.log(`  checksum ${tiles.length} tiles: ${ms(stat(times))} ms`);
  }

  // ── 3. EXTRACT all tiles ──
  console.log("\n--- 3. EXTRACT (all tiles, Buffer.copy) ---");
  {
    const times = [];
    for (let i = 0; i < ITER; i++) {
      const t = performance.now();
      for (const tl of tiles) extractTile(screen, tl.x, tl.y, tl.w, tl.h);
      times.push(performance.now() - t);
    }
    console.log(`  extract ${tiles.length} tiles: ${ms(stat(times))} ms`);
  }

  // ── 4. ENCODE compare: JPEG vs WebP vs AVIF (single tile, full grid) ──
  console.log("\n--- 4. ENCODE compare (full-frame, mapLimit concurrency) ---");
  const rawTiles = tiles.map((tl) => ({ ...tl, raw: extractTile(screen, tl.x, tl.y, tl.w, tl.h) }));
  for (const [name, fn] of [["JPEG", encodeJPEG], ["WebP", encodeWEBP], ["AVIF", encodeAVIF]]) {
    const times = [];
    let totalBytes = 0;
    for (let i = 0; i < ITER; i++) {
      const t = performance.now();
      const out = await mapLimit(rawTiles, CONCURRENCY, (tl) => fn(tl.raw, tl.w, tl.h));
      times.push(performance.now() - t);
      if (i === 0) totalBytes = out.reduce((a, b) => a + b.length, 0);
    }
    console.log(`  ${name.padEnd(5)}: frame ${ms(stat(times))} ms | size ${kb(totalBytes)} (${tiles.length} tiles)`);
  }

  // ── 5. BATCH encode (real encodeTilesBatch) ──
  console.log("\n--- 5. BATCH (encodeTilesBatch, JPEG tiles) ---");
  {
    const jpegTiles = await mapLimit(rawTiles, CONCURRENCY, async (tl) => ({
      tileIndex: 0, x: tl.x, y: tl.y, width: tl.w, height: tl.h, hash: 123,
      imageBuffer: await encodeJPEG(tl.raw, tl.w, tl.h)
    }));
    const times = [];
    for (let i = 0; i < ITER; i++) {
      const t = performance.now();
      encodeTilesBatch(jpegTiles, Date.now());
      times.push(performance.now() - t);
    }
    console.log(`  batch ${jpegTiles.length} tiles: ${ms(stat(times))} ms`);
  }

  // ── 6. FULL pipeline (checksum→extract→JPEG encode→batch), synthetic ──
  console.log("\n--- 6. FULL pipeline per frame (checksum+extract+JPEG+batch) ---");
  {
    const times = [];
    for (let i = 0; i < ITER; i++) {
      const t = performance.now();
      for (const tl of tiles) checksumTile(screen, tl.x, tl.y, tl.w, tl.h);
      const encoded = await mapLimit(tiles, CONCURRENCY, async (tl) => ({
        tileIndex: 0, x: tl.x, y: tl.y, width: tl.w, height: tl.h, hash: 1,
        imageBuffer: await encodeJPEG(extractTile(screen, tl.x, tl.y, tl.w, tl.h), tl.w, tl.h)
      }));
      encodeTilesBatch(encoded, Date.now());
      times.push(performance.now() - t);
    }
    console.log(`  full frame: ${ms(stat(times))} ms  → theoretical max FPS = ${(1000 / stat(times).p50).toFixed(1)}`);
  }

  console.log("\n=== DONE ===");
}

main().catch((e) => { console.error("BENCH ERROR:", e); process.exit(1); });
