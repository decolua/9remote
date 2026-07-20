// Remote desktop memory leak test — isolates capture vs encode vs full pipeline.
// Mode "all" runs capture → encode → full sequentially and diagnoses which leaks.
//
// Usage (run from agent/ or repo root):
//   node --expose-gc agent/tester/remote/leakTest.mjs                        # all phases, 300f each
//   node --expose-gc agent/tester/remote/leakTest.mjs mode=full frames=600
//   node --expose-gc agent/tester/remote/leakTest.mjs mode=all frames=400 intervalMs=60 prefetch=true
//
// --expose-gc required for forced-GC passes (separates JS leak vs native retention).
// Args: key=value. Keys: mode, frames, tile, quality, concurrency, logEvery,
//       yield (true|false, default true), intervalMs (production pacing, default 0),
//       prefetch (true|false, default false — mirrors TileManager 2-frame in-flight).
import { performance } from "perf_hooks";
import { setTimeout as sleep } from "timers/promises";
import { writeFileSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import sharp from "sharp";

import { encodeTilesBatch } from "../../features/remote/handlers/ScreenHandler.js";
import { mapLimit } from "../../features/remote/TileManager.js";

// Match production sharp config (encoderAdapter.js)
sharp.cache(false);
sharp.concurrency(1);

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "leakTest.log");

// ─── arg parsing ────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.includes("="))
    .map((a) => {
      const [k, ...v] = a.split("=");
      return [k, v.join("=")];
    })
);
const MODE = args.mode || "all";                  // capture | encode | full | all
const FRAMES = Number(args.frames || 300);
const TILE = Number(args.tile || 128);
const QUALITY = Number(args.quality || 50);
const CONCURRENCY = Number(args.concurrency || 6);
const LOG_EVERY = Number(args.logEvery || 30);
const YIELD_BETWEEN = args.yield !== "false";     // default true — drain native finalizers
const INTERVAL_MS = Number(args.intervalMs || 0); // 0 = max speed; 60 = production activeInterval
const PREFETCH = args.prefetch === "true";        // default false — 2-frame in-flight like prod

// ─── synthetic screen (for encode-only / fallback) ─────────────
function makeSynthetic(width, height, channels = 4) {
  const buf = Buffer.allocUnsafe(width * height * channels);
  let seed = 0x12345678;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const block = (((x >> 7) + (y >> 7)) & 1) * 40;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const dither = (seed >> 20) & 7;
      buf[i] = (80 + block + ((x * 120 / width) | 0) + dither) & 0xff;
      buf[i + 1] = (90 + block + ((y * 100 / height) | 0) + dither) & 0xff;
      buf[i + 2] = (120 + block + dither) & 0xff;
      buf[i + 3] = 255;
    }
  }
  return { buffer: buf, width, height, channels };
}

function tileGrid(width, height) {
  const cols = Math.ceil(width / TILE);
  const rows = Math.ceil(height / TILE);
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * TILE, y = r * TILE;
      tiles.push({ x, y, w: Math.min(TILE, width - x), h: Math.min(TILE, height - y) });
    }
  }
  return tiles;
}

function extractTile(screen, tl) {
  const ch = screen.channels;
  const rowBytes = tl.w * ch;
  const tileBuf = Buffer.allocUnsafe(tl.w * tl.h * ch);
  for (let y = 0; y < tl.h; y++) {
    const src = ((tl.y + y) * screen.width + tl.x) * ch;
    screen.buffer.copy(tileBuf, y * rowBytes, src, src + rowBytes);
  }
  return tileBuf;
}

// ─── logging ────────────────────────────────────────────────────
function logLine(line) {
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

function mb(b) { return (b / 1048576).toFixed(1); }

function snapshot() {
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed, external: m.external, arrayBuf: m.arrayBuffers };
}

function gcIfAvailable() {
  if (typeof global.gc === "function") {
    global.gc();
    global.gc(); // run twice — finalizers may free on second pass
  }
}

// ─── capture helper ─────────────────────────────────────────────
let monitor = null;
async function getMonitor() {
  if (monitor) return monitor;
  const ns = await import("node-screenshots");
  const Monitor = ns.Monitor || ns.default?.Monitor;
  monitor = Monitor.all()[0];
  if (!monitor) throw new Error("No monitor via node-screenshots");
  return monitor;
}

async function captureFrame() {
  const m = await getMonitor();
  const img = await m.captureImage();
  // Read dims + copy raw BEFORE img drops out of scope — V8 finalizer can then
  // release the native DXGI/XCap surface as soon as this function returns.
  const width = img.width;
  const height = img.height;
  const raw = await img.toRaw();
  return { buffer: raw, width, height, channels: 4 };
}

// ─── encode (matches REMOTE_CONFIG: webp effort 0) ──────────────
async function encodeTileWebp(buf, w, h) {
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } })
    .webp({ quality: QUALITY, effort: 0 }).toBuffer();
}

// ─── trend analysis: leak (linear) vs plateau (stable pool) ─────
// A real leak keeps growing in the 2nd half. A native pool/arena levels off.
function analyzeTrend(samplesMb) {
  if (samplesMb.length < 4) return { slopePer100: 0, tailGrowth: 0 };
  const half = Math.floor(samplesMb.length / 2);
  const tail = samplesMb.slice(half);
  const n = tail.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = tail.reduce((s, v) => s + v, 0);
  const sumXY = tail.reduce((s, v, i) => s + i * v, 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0; // MB/sample
  // Convert MB/sample → MB/100 frames using LOG_EVERY
  const slopePer100 = slope * (100 / LOG_EVERY);
  const tailGrowth = tail[tail.length - 1] - tail[0];
  return { slopePer100, tailGrowth };
}

function classifyVerdict(totalGrowthMb, tailGrowthMb, slopePer100) {
  if (slopePer100 > 0.3 && tailGrowthMb > 10) {
    return { tag: "LEAK-LIKE", text: `RSS still climbing in 2nd half (+${tailGrowthMb.toFixed(1)}MB, slope ${slopePer100.toFixed(2)}MB/100f). Total +${totalGrowthMb.toFixed(1)}MB.` };
  }
  if (totalGrowthMb > 50 && tailGrowthMb < 10) {
    return { tag: "STABLE-PLATEAU", text: `+${totalGrowthMb.toFixed(1)}MB total but only +${tailGrowthMb.toFixed(1)}MB in 2nd half. Native pool/arena retention, not a leak.` };
  }
  if (totalGrowthMb < 30) {
    return { tag: "STABLE", text: `+${totalGrowthMb.toFixed(1)}MB total. Within allocator noise.` };
  }
  return { tag: "AMBIGUOUS", text: `+${totalGrowthMb.toFixed(1)}MB total, +${tailGrowthMb.toFixed(1)}MB in 2nd half. Re-run with more frames.` };
}

// ─── single phase runner ────────────────────────────────────────
async function runPhase(mode, frames, synth, tiles) {
  logLine(`\n${"=".repeat(70)}`);
  logLine(`PHASE mode=${mode} frames=${frames} yield=${YIELD_BETWEEN} intervalMs=${INTERVAL_MS} prefetch=${PREFETCH}`);
  logLine("=".repeat(70));

  gcIfAvailable();
  await sleep(500); // let native allocators settle after GC
  const base = snapshot();
  const baseRssMb = base.rss / 1048576;
  logLine(`[base] rss=${mb(base.rss)}MB heap=${mb(base.heap)}MB ext=${mb(base.external)}MB`);
  logLine("frame,rss_mb,heap_mb,external_mb,delta_rss_mb,delta_heap_mb");

  const samplesMb = [];
  const t0 = performance.now();

  // Prefetch mirrors TileManager.getCaptureForStreaming: next capture starts
  // while current encodes — 2 DXGI surfaces alive at once (production state).
  let pending = (mode === "capture" || mode === "full") ? captureFrame() : null;

  for (let f = 1; f <= frames; f++) {
    let screen;
    if (mode === "capture" || mode === "full") {
      screen = await pending;
      pending = (PREFETCH && f < frames) ? captureFrame() : null;
    } else {
      screen = synth;
    }

    if (mode === "encode" || mode === "full") {
      const encoded = await mapLimit(tiles, CONCURRENCY, async (tl) => {
        const raw = extractTile(screen, tl);
        const img = await encodeTileWebp(raw, tl.w, tl.h);
        return { tileIndex: 0, x: tl.x, y: tl.y, width: tl.w, height: tl.h, hash: f, imageBuffer: img };
      });
      encodeTilesBatch(encoded, Date.now());
    }

    if (YIELD_BETWEEN) await new Promise((r) => setImmediate(r));

    if (f % LOG_EVERY === 0 || f === frames) {
      const s = snapshot();
      samplesMb.push(s.rss / 1048576);
      const dRss = s.rss - base.rss;
      const dHeap = s.heap - base.heap;
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      logLine(`${f},${mb(s.rss)},${mb(s.heap)},${mb(s.external)},${mb(dRss)},${mb(dHeap)}`);
      console.log(`  [${mode}] ${f}/${frames} | ${elapsed}s | rss ${mb(s.rss)}MB (+${mb(dRss)}MB) | heap ${mb(s.heap)}MB`);
    }

    if (INTERVAL_MS > 0) await sleep(INTERVAL_MS);
  }

  gcIfAvailable();
  const afterGc = snapshot();
  const finalRssMb = samplesMb[samplesMb.length - 1] ?? baseRssMb;
  const totalGrowthMb = finalRssMb - baseRssMb;
  const trend = analyzeTrend(samplesMb);
  const verdict = classifyVerdict(totalGrowthMb, trend.tailGrowth, trend.slopePer100);

  logLine(`[gc-final] rss=${mb(afterGc.rss)}MB heap=${mb(afterGc.heap)}MB ext=${mb(afterGc.external)}MB`);
  logLine(`[VERDICT:${verdict.tag}] ${verdict.text}`);
  logLine(`[trend] slope=${trend.slopePer100.toFixed(2)}MB/100f | tailGrowth=+${trend.tailGrowth.toFixed(1)}MB`);

  return {
    mode,
    baseRssMb,
    finalRssMb,
    totalGrowthMb,
    tailGrowthMb: trend.tailGrowth,
    slopePer100: trend.slopePer100,
    verdictTag: verdict.tag
  };
}

// ─── main ───────────────────────────────────────────────────────
async function main() {
  const header = [
    `=== Remote desktop leak test (detect-all) ===`,
    `mode=${MODE} frames=${FRAMES} tile=${TILE} q=${QUALITY} concurrency=${CONCURRENCY}`,
    `yield=${YIELD_BETWEEN} intervalMs=${INTERVAL_MS} prefetch=${PREFETCH}`,
    `node=${process.version} platform=${process.platform} arch=${process.arch}`,
    `gc exposed: ${typeof global.gc === "function"}`,
    `started=${new Date().toISOString()}`,
    ``,
  ].join("\n");
  writeFileSync(LOG_FILE, header);
  console.log(header);

  // Detect screen + capture availability
  let screenDims = { width: 1920, height: 1080 };
  let captureAvailable = false;
  try {
    await captureFrame(); // warm-up
    captureAvailable = true;
    const probe = await captureFrame();
    screenDims = { width: probe.width, height: probe.height };
    logLine(`[capture] available — real screen ${screenDims.width}x${screenDims.height}`);
  } catch (e) {
    logLine(`[capture] UNAVAILABLE: ${e.message}`);
    logLine(`          → running encode-only with synthetic ${screenDims.width}x${screenDims.height}`);
  }

  const synth = makeSynthetic(screenDims.width, screenDims.height);
  const tiles = tileGrid(screenDims.width, screenDims.height);
  logLine(`[grid] ${screenDims.width}x${screenDims.height} → ${tiles.length} tiles @ ${TILE}px`);

  const phases = MODE === "all"
    ? (captureAvailable ? ["capture", "encode", "full"] : ["encode"])
    : [MODE];

  const results = [];
  for (const phase of phases) {
    if (results.length > 0) {
      logLine(`\n[cooldown] 2s sleep + GC before next phase...`);
      await sleep(2000);
      gcIfAvailable();
    }
    results.push(await runPhase(phase, FRAMES, synth, tiles));
  }

  // ─── final summary + cross-phase diagnosis ───────────────────
  logLine(`\n${"#".repeat(70)}`);
  logLine(`# SUMMARY — leak detection`);
  logLine("#".repeat(70));
  logLine(`${"phase".padEnd(10)} ${"total".padStart(8)} ${"2nd-half".padStart(9)} ${"slope/100f".padStart(10)}  verdict`);
  for (const r of results) {
    logLine(`${r.mode.padEnd(10)} ${("+" + r.totalGrowthMb.toFixed(1) + "MB").padStart(8)} ${("+" + r.tailGrowthMb.toFixed(1) + "MB").padStart(9)} ${r.slopePer100.toFixed(2).padStart(10)}  ${r.verdictTag}`);
  }
  logLine("");

  const capture = results.find((r) => r.mode === "capture");
  const encode = results.find((r) => r.mode === "encode");
  const full = results.find((r) => r.mode === "full");

  logLine("[diagnosis]");
  let foundLeak = false;
  if (capture && capture.tailGrowthMb > 10) {
    foundLeak = true;
    logLine(`  ⚠️ CAPTURE leaks (+${capture.tailGrowthMb.toFixed(1)}MB in 2nd half) → node-screenshots native leak (${process.platform === "win32" ? "DXGI" : "XCap"}). JS-side cannot fix — upstream issue.`);
  }
  if (encode && encode.tailGrowthMb > 10) {
    foundLeak = true;
    logLine(`  ⚠️ ENCODE leaks (+${encode.tailGrowthMb.toFixed(1)}MB in 2nd half) → sharp/libvips. Try MALLOC_ARENA_MAX=2 (Linux) or upgrade sharp.`);
  }
  if (full && capture && encode) {
    const sum = capture.totalGrowthMb + encode.totalGrowthMb;
    if (full.totalGrowthMb > sum * 1.3 && full.tailGrowthMb > 10) {
      foundLeak = true;
      logLine(`  ⚠️ FULL (${full.totalGrowthMb.toFixed(1)}MB) > capture+encode (${sum.toFixed(1)}MB) → prefetch/2-frame in-flight amplifies retention. Check TileManager.getCaptureForStreaming.`);
    }
  }
  if (!foundLeak) {
    logLine(`  ✅ No leak detected — all phases plateau in 2nd half. High RSS is native pool/arena retention (normal on ${process.platform}).`);
  }

  logLine(`\n[done] full log → ${LOG_FILE}`);
  process.exit(0);
}

main().catch((e) => {
  appendFileSync(LOG_FILE, `\n[FATAL] ${e.stack || e.message}\n`);
  console.error("LEAK TEST ERROR:", e);
  process.exit(1);
});
