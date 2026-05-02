// Full-screen codec benchmark — encode 1 full frame N times per codec.
// Measures: avg size, avg encode time, CPU usage.
// Usage: node fullScreenBenchmark.js

import sharp from "sharp";
import { Monitor } from "node-screenshots";
import fs from "fs";
import path from "path";

const ITERATIONS = 10;
const OUT_DIR = "./fullscreen-output";

const CODECS = [
  { name: "jpeg-q50", ext: "jpg",  fn: (img) => img.jpeg({ quality: 50 }).toBuffer() },
  { name: "jpeg-q70", ext: "jpg",  fn: (img) => img.jpeg({ quality: 70 }).toBuffer() },
  { name: "jpeg-q85", ext: "jpg",  fn: (img) => img.jpeg({ quality: 85 }).toBuffer() },
  { name: "webp-q50", ext: "webp", fn: (img) => img.webp({ quality: 50 }).toBuffer() },
  { name: "webp-q70", ext: "webp", fn: (img) => img.webp({ quality: 70 }).toBuffer() },
  { name: "webp-q85", ext: "webp", fn: (img) => img.webp({ quality: 85 }).toBuffer() },
  { name: "avif-q50", ext: "avif", fn: (img) => img.avif({ quality: 50 }).toBuffer() },
  { name: "png",      ext: "png",  fn: (img) => img.png().toBuffer() }
];

async function main() {
  console.log("=== Full-Screen Codec Benchmark ===");
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const monitor = Monitor.all()[0];
  console.log(`Screen: ${monitor.width}x${monitor.height} | iterations=${ITERATIONS}`);
  console.log(`Output: ${path.resolve(OUT_DIR)}\n`);

  const image = monitor.captureImageSync();
  const raw = image.toRawSync ? image.toRawSync() : image.rawSync();
  const width = image.width;
  const height = image.height;
  console.log(`Raw size: ${(raw.length / 1024 / 1024).toFixed(2)}MB (${width}x${height} RGBA)\n`);

  const results = [];

  for (const codec of CODECS) {
    let totalBytes = 0;
    let totalMs = 0;
    let firstEncoded = null;

    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
      const img = sharp(raw, { raw: { width, height, channels: 4 } });
      const t = performance.now();
      const out = await codec.fn(img);
      totalMs += performance.now() - t;
      totalBytes += out.length;
      if (i === 0) firstEncoded = out;
    }

    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const cpuPct = ((cpuMs / wallMs) * 100).toFixed(0);

    fs.writeFileSync(path.join(OUT_DIR, `fullscreen_${codec.name}.${codec.ext}`), firstEncoded);

    const avgKB = (totalBytes / ITERATIONS / 1024).toFixed(1);
    const avgMs = (totalMs / ITERATIONS).toFixed(1);
    results.push({ name: codec.name, avgKB, avgMs, cpuPct, totalMs: totalMs.toFixed(0) });
  }

  // Print table
  console.log("Codec        | Size (KB) | Enc (ms) | CPU%  | Total (ms, x10)");
  console.log("-------------|-----------|----------|-------|----------------");
  for (const r of results) {
    console.log(`${r.name.padEnd(12)} | ${r.avgKB.padStart(9)} | ${r.avgMs.padStart(8)} | ${r.cpuPct.padStart(4)}% | ${r.totalMs.padStart(14)}`);
  }

  console.log(`\n✅ Done — open ${OUT_DIR}/ to compare visual quality`);
  process.exit(0);
}

main().catch((err) => { console.error("❌", err); process.exit(1); });
