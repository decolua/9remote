// All-in-one monitor test: enumerate, capture each, fromPoint, robotjs vs node-screenshots.
// Run on Windows multi-monitor: node agent/tester/remote/monitor/run-all.mjs
// Logs to console + agent/temp/monitor-test.log. Writes per-monitor PNGs to agent/temp/.
import fs from "fs";
import path from "path";
import { Monitor } from "node-screenshots";

const outDir = path.join(import.meta.dirname, "../../../temp");
fs.mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, "monitor-test.log");

const lines = [];
const log = (msg = "") => { lines.push(msg); console.log(msg); };
const hr = "=".repeat(70);

function bytesKB(b) { return `${(b / 1024).toFixed(1)} KB`; }

// ===== TEST 1: list monitors =====
log(hr);
log("TEST 1: Monitor.all() — enumerate displays");
log(hr);
let monitors = [];
try {
  monitors = Monitor.all();
  log(`Found ${monitors.length} monitor(s)\n`);
  monitors.forEach((m, i) => {
    const tag = m.isPrimary() ? " (PRIMARY)" : "";
    log(`[${i}] id=${m.id()} "${m.name()}"${tag}`);
    log(`    pos=(${m.x()},${m.y()}) ${m.width()}x${m.height()} rotation=${m.rotation()} scale=${m.scaleFactor()} freq=${m.frequency()} builtin=${m.isBuiltin()}`);
  });
  const xs = monitors.map((m) => m.x()), xes = monitors.map((m) => m.x() + m.width());
  const ys = monitors.map((m) => m.y()), yes = monitors.map((m) => m.y() + m.height());
  log(`\nVirtual desktop: x[${Math.min(...xs)}..${Math.max(...xes)}] y[${Math.min(...ys)}..${Math.max(...yes)}]`);
} catch (err) {
  log(`✗ FAILED: ${err.message}`);
}

// ===== TEST 2: capture each monitor by index =====
log("\n" + hr);
log(`TEST 2: capture each monitor by index (${monitors.length} total)`);
log(hr);
const captures = [];
for (let i = 0; i < monitors.length; i++) {
  const m = monitors[i];
  try {
    const t0 = performance.now();
    const img = await m.captureImage();
    const dt = (performance.now() - t0).toFixed(1);
    const match = img.width === m.width() && img.height === m.height();
    const out = path.join(outDir, `monitor-${i}.png`);
    const png = img.toPngSync();
    fs.writeFileSync(out, png);
    captures.push({ index: i, w: img.width, h: img.height, png: out });
    log(`\n[${i}] id=${m.id()} "${m.name()}"`);
    log(`    metadata : ${m.width()}x${m.height()}`);
    log(`    captured : ${img.width}x${img.height} in ${dt}ms — dim match ${match ? "OK ✓" : "MISMATCH ✗ (metadata=logical, capture=physical)"}`);
    log(`    png      : ${bytesKB(png.length)} → ${out}`);
  } catch (err) {
    log(`\n[${i}] ✗ FAILED: ${err.message}`);
  }
}

// ===== TEST 3: fromPoint for each monitor origin =====
log("\n" + hr);
log("TEST 3: Monitor.fromPoint(x, y) — resolve display by coordinates");
log(hr);
for (let i = 0; i < monitors.length; i++) {
  const m = monitors[i];
  const px = m.x() + Math.floor(m.width() / 2);
  const py = m.y() + Math.floor(m.height() / 2);
  try {
    const resolved = Monitor.fromPoint(px, py);
    const ok = resolved && resolved.id() === m.id();
    log(`[${i}] point(${px},${py}) → id=${resolved?.id()} "${resolved?.name()}" ${ok ? "OK ✓" : "MISMATCH ✗"}`);
  } catch (err) {
    log(`[${i}] point(${px},${py}) ✗ FAILED: ${err.message}`);
  }
}

// ===== TEST 4: robotjs vs node-screenshots (primary only vs all) =====
log("\n" + hr);
log("TEST 4: robotjs getScreenSize() vs node-screenshots");
log(hr);
try {
  const robotMod = await import("@hurdlegroup/robotjs");
  const robot = robotMod.default || robotMod;
  const { width, height } = robot.getScreenSize();
  const bmp = robot.screen.capture(0, 0, width, height);
  const physW = bmp.byteWidth / bmp.bytesPerPixel;
  log(`robotjs logical    : ${width}x${height}`);
  log(`robotjs bitmap     : ${physW}x${bmp.height} (single primary screen only)`);
  const primary = monitors.find((m) => m.isPrimary()) ?? monitors[0];
  log(`node-screenshots   : ${monitors.length} monitor(s), primary ${primary.width()}x${primary.height()} id=${primary.id()}`);
  log(`\nConclusion: robotjs sees only primary → switching monitors MUST use node-screenshots by index`);
} catch (err) {
  log(`✗ robotjs FAILED (ok on headless): ${err.message}`);
}

// ===== Summary =====
log("\n" + hr);
log("SUMMARY");
log(hr);
log(`Monitors detected : ${monitors.length}`);
log(`Captured OK       : ${captures.length}/${monitors.length}`);
for (const c of captures) log(`  [${c.index}] ${c.w}x${c.h} → ${path.basename(c.png)}`);
log(`\nLog file: ${logPath}`);
log(hr);

fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
