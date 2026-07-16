// Test 3: resolve a monitor from a point, then capture it.
// Run: node agent/tester/remote/monitor/capture-by-point.mjs <x> <y>
// Verifies Monitor.fromPoint() picks the right display in a virtual-desktop layout.
import fs from "fs";
import path from "path";
import { Monitor } from "node-screenshots";

const x = Number(process.argv[2] ?? 0);
const y = Number(process.argv[3] ?? 0);

console.log(`\n=== Monitor.fromPoint(${x}, ${y}) ===`);
const m = Monitor.fromPoint(x, y);
if (!m) {
  console.error(`✗ no monitor at (${x}, ${y})`);
  process.exit(1);
}

console.log(`resolved: id=${m.id()} "${m.name()}" ${m.width()}x${m.height()} at (${m.x()},${m.y()}) primary=${m.isPrimary()}`);

const img = await m.captureImage();
console.log(`captured: ${img.width}x${img.height}`);

const outDir = path.join(import.meta.dirname, "../../../temp");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `point-${x}-${y}.png`);
fs.writeFileSync(out, img.toPngSync());
console.log(`saved: ${out}`);
