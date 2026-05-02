// Codec benchmark — compare JPEG/WebP/AVIF/PNG on real screen tiles.
// Saves sample tiles + composed full frames to ./codec-output for visual review.
// Usage: node codecBenchmark.js

import sharp from "sharp";
import { Monitor } from "node-screenshots";
import fs from "fs";
import path from "path";

const TILE_SIZE = 128;
const SAMPLE_LIMIT = 50;
const SAMPLE_SAVE_COUNT = 6; // tiles to save per codec for visual diff
const OUT_DIR = "./codec-output";

const monitor = Monitor.all()[0];

const SCENARIOS = [
  { name: "idle", waitMs: 2000, hint: "Đừng chạm chuột/bàn phím" },
  { name: "scroll", waitMs: 2000, hint: "Cuộn 1 trang web liên tục" },
  { name: "fullchange", waitMs: 2000, hint: "Đổi tab/cửa sổ liên tục" }
];

const CODECS = [
  { name: "jpeg-q50", ext: "jpg",  fn: (img) => img.jpeg({ quality: 50 }).toBuffer() },
  { name: "jpeg-q70", ext: "jpg",  fn: (img) => img.jpeg({ quality: 70 }).toBuffer() },
  { name: "webp-q50", ext: "webp", fn: (img) => img.webp({ quality: 50 }).toBuffer() },
  { name: "webp-q70", ext: "webp", fn: (img) => img.webp({ quality: 70 }).toBuffer() },
  { name: "avif-q50", ext: "avif", fn: (img) => img.avif({ quality: 50 }).toBuffer() },
  { name: "png",      ext: "png",  fn: (img) => img.png().toBuffer() }
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function captureFull() {
  const image = monitor.captureImageSync();
  const raw = image.toRawSync ? image.toRawSync() : image.rawSync();
  return { buffer: raw, width: image.width, height: image.height, channels: 4 };
}

function buildTiles(width, height) {
  const tiles = [];
  for (let y = 0; y < height; y += TILE_SIZE) {
    for (let x = 0; x < width; x += TILE_SIZE) {
      tiles.push({ x, y, w: Math.min(TILE_SIZE, width - x), h: Math.min(TILE_SIZE, height - y) });
    }
  }
  return tiles;
}

function diffTiles(buf1, buf2, tiles, width, channels) {
  const changed = [];
  for (const t of tiles) {
    let diff = false;
    const stride = width * channels;
    for (let py = 0; py < t.h && !diff; py++) {
      const off = (t.y + py) * stride + t.x * channels;
      for (let i = 0; i < t.w * channels; i++) {
        if (buf1[off + i] !== buf2[off + i]) { diff = true; break; }
      }
    }
    if (diff) changed.push(t);
  }
  return changed;
}

function cropTile(buffer, t, width, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(t.w * t.h * channels);
  for (let py = 0; py < t.h; py++) {
    buffer.copy(out, py * t.w * channels, (t.y + py) * stride + t.x * channels, (t.y + py) * stride + (t.x + t.w) * channels);
  }
  return out;
}

async function encodeTile(rawBuf, t, codec) {
  const img = sharp(rawBuf, { raw: { width: t.w, height: t.h, channels: 4 } });
  const start = performance.now();
  const out = await codec.fn(img);
  return { bytes: out.length, ms: performance.now() - start, encoded: out };
}

async function saveFullScene(buffer, width, height, scenario) {
  const png = await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, `${scenario}_full.png`), png);
}

async function runScenario(scenario) {
  console.log(`\n📸 [${scenario.name}] ${scenario.hint} (${scenario.waitMs / 1000}s)`);
  await sleep(scenario.waitMs);
  const f1 = await captureFull();
  await sleep(500);
  const f2 = await captureFull();

  const tiles = buildTiles(f2.width, f2.height);
  const changed = diffTiles(f1.buffer, f2.buffer, tiles, f2.width, f2.channels);
  console.log(`  Tiles: ${changed.length}/${tiles.length} changed`);

  await saveFullScene(f2.buffer, f2.width, f2.height, scenario.name);

  if (changed.length === 0) {
    console.log("  ⚠️ No changes, skip");
    return;
  }

  const sample = changed.slice(0, Math.min(SAMPLE_LIMIT, changed.length));
  const saveTiles = sample.slice(0, SAMPLE_SAVE_COUNT);

  // Save raw sample tiles as PNG ground truth
  for (let i = 0; i < saveTiles.length; i++) {
    const t = saveTiles[i];
    const raw = cropTile(f2.buffer, t, f2.width, f2.channels);
    const png = await sharp(raw, { raw: { width: t.w, height: t.h, channels: 4 } }).png().toBuffer();
    fs.writeFileSync(path.join(OUT_DIR, `${scenario.name}_tile${i}_raw.png`), png);
  }

  for (const codec of CODECS) {
    let totalBytes = 0;
    let totalMs = 0;
    for (let i = 0; i < sample.length; i++) {
      const t = sample[i];
      const raw = cropTile(f2.buffer, t, f2.width, f2.channels);
      const { bytes, ms, encoded } = await encodeTile(raw, t, codec);
      totalBytes += bytes;
      totalMs += ms;
      if (i < SAMPLE_SAVE_COUNT) {
        fs.writeFileSync(path.join(OUT_DIR, `${scenario.name}_tile${i}_${codec.name}.${codec.ext}`), encoded);
      }
    }
    const avgKB = (totalBytes / sample.length / 1024).toFixed(2);
    const avgMs = (totalMs / sample.length).toFixed(2);
    const totalKB = (totalBytes / 1024).toFixed(1);
    console.log(`  ${codec.name.padEnd(12)} avg=${avgKB}KB enc=${avgMs}ms total=${totalKB}KB`);
  }
}

async function main() {
  console.log("=== Codec Benchmark ===");
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Screen: ${monitor.width}x${monitor.height} | tileSize=${TILE_SIZE} | platform=${process.platform}`);
  console.log(`Output: ${path.resolve(OUT_DIR)}\n`);
  console.log("Scenarios:");
  SCENARIOS.forEach((s) => console.log(`  ${s.name}: ${s.hint}`));

  for (const s of SCENARIOS) await runScenario(s);

  console.log(`\n✅ Done — open ${OUT_DIR}/ to compare visual quality`);
  process.exit(0);
}

main().catch((err) => { console.error("❌", err); process.exit(1); });
