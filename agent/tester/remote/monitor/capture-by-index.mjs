// Test 2: capture a specific monitor by index, verify dimensions match metadata.
// Run: node agent/tester/remote/monitor/capture-by-index.mjs [index]
// Default index=0. Writes PNG to agent/temp/monitor-<index>.png for visual check.
import fs from "fs";
import path from "path";
import { Monitor } from "node-screenshots";

const idx = Number(process.argv[2] ?? 0);
const monitors = Monitor.all();
const m = monitors[idx];

if (!m) {
  console.error(`✗ index ${idx} out of range (have ${monitors.length} monitors: 0..${monitors.length - 1})`);
  process.exit(1);
}

console.log(`\n=== Capturing monitor[${idx}] id=${m.id()} "${m.name()}" ===`);
console.log(`metadata: ${m.width()}x${m.height()} at (${m.x()},${m.y()}) scale=${m.scaleFactor()} primary=${m.isPrimary()}`);

const t0 = performance.now();
const img = await m.captureImage(); // async — matches captureAdapter.js path
const dt = (performance.now() - t0).toFixed(1);

console.log(`captured: ${img.width}x${img.height} in ${dt}ms`);
console.log(`dim match: ${img.width === m.width() && img.height === m.height() ? "OK ✓" : "MISMATCH ✗"}`);

const outDir = path.join(import.meta.dirname, "../../../temp");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `monitor-${idx}.png`);
fs.writeFileSync(out, img.toPngSync());
console.log(`saved: ${out}`);
