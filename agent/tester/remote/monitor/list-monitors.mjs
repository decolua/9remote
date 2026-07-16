// Test 1: enumerate all monitors via node-screenshots.
// Run: node agent/tester/remote/monitor/list-monitors.mjs
// Verifies Monitor.all() returns multiple displays on Windows multi-monitor.
import { Monitor } from "node-screenshots";

const monitors = Monitor.all();
console.log(`\n=== Found ${monitors.length} monitor(s) ===\n`);

const list = monitors.map((m, i) => ({
  index: i,
  id: m.id(),
  name: m.name(),
  x: m.x(),
  y: m.y(),
  width: m.width(),
  height: m.height(),
  rotation: m.rotation(),
  scaleFactor: m.scaleFactor(),
  frequency: m.frequency(),
  isPrimary: m.isPrimary(),
  isBuiltin: m.isBuiltin()
}));

for (const m of list) {
  const tag = m.isPrimary ? " (PRIMARY)" : "";
  console.log(`[${m.index}] id=${m.id} "${m.name}"${tag}`);
  console.log(`    pos=(${m.x},${m.y}) ${m.width}x${m.height} rotation=${m.rotation} scale=${m.scaleFactor} freq=${m.frequency} builtin=${m.isBuiltin}`);
}

console.log(`\nSummary: ${list.length} monitor(s), primary id=${list.find((m) => m.isPrimary)?.id ?? "none"}`);
console.log(`Virtual desktop bounds: x[${Math.min(...list.map((m) => m.x))}..${Math.max(...list.map((m) => m.x + m.width))}] y[${Math.min(...list.map((m) => m.y))}..${Math.max(...list.map((m) => m.y + m.height))}]`);
