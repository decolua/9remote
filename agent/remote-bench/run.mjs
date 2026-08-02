// remote-bench entry: preflight (compat) → tests → build probe → steps 1-8 → leak report → summary.
// Every step is wrapped: a failure logs + continues. No single step kills the suite.
import { Logger } from "./lib/logger.mjs";
import { LeakTracker } from "./lib/leak.mjs";
import { detectCompat } from "./lib/compat.mjs";
import { buildProbe } from "./probe/build.mjs";

const OUT = new URL("./out/", import.meta.url);
const DUMP = new URL("./out/dump/", import.meta.url);
const STEPS = [
  "1_capture.mjs", "2_resize.mjs", "3_checksum.mjs", "4_extract.mjs",
  "5_encode.mjs", "6_e2e.mjs", "7_gpu.mjs", "8_dxgi_native.mjs"
];

async function loadStep(name) {
  return (await import(new URL(`./steps/${name}`, import.meta.url).href)).default;
}

const log = new Logger(OUT);

// ── 0. GC hint ────────────────────────────────────────────────────────────────
if (typeof global.gc !== "function") {
  log.warn("run with --expose-gc for accurate leak snapshots (node --expose-gc run.mjs)");
}

// ── 1. Compat / system info ───────────────────────────────────────────────────
const compat = await detectCompat();
log.info("[system]", compat);
log.event("compat", compat);
const canRun = compat.isWin;
if (!canRun) log.warn("non-Windows host — GPU + DXGI native steps will skip");

// ── 2. Build native DXGI probe (best-effort) ─────────────────────────────────
let dxgiExe = null;
try {
  log.info("[build] compiling DXGI probe...");
  dxgiExe = await buildProbe({ log });
  log.info("[build] probe ready", { exe: dxgiExe });
} catch (e) {
  log.warn(`[build] DXGI probe unavailable — step 8 skipped`, { err: e.message });
}

// ── 3. Run steps ──────────────────────────────────────────────────────────────
const leak = new LeakTracker({ leakThresholdMB: 50 });
leak.snapshot("start");
const results = {};
for (const name of STEPS) {
  leak.snapshot(`before-${name}`);
  const t0 = performance.now();
  try {
    const step = await loadStep(name);
    const r = await step({ logger: log, leak, dumpDir: DUMP, dxgiExe });
    results[name] = r;
    leak.snapshot(`after-${name}`);
    const lr = leak.report(`before-${name}`, `after-${name}`);
    log.event("leak", { step: name, ...lr });
    log.info(`✓ ${name} ${(performance.now() - t0).toFixed(0)}ms`);
  } catch (e) {
    results[name] = { name, error: e.message };
    log.error(`✗ ${name} failed`, { err: e.message, stack: e.stack?.split("\n")[1] });
  }
}
leak.snapshot("end");
const totalLeak = leak.report("start", "end");
log.event("leak", { step: "TOTAL", ...totalLeak });
if (totalLeak.leaked) log.warn(`possible leak — RSS +${totalLeak.rssDeltaMB.toFixed(0)}MB`, { outstanding: totalLeak.outstanding });

// ── 4. Summary ────────────────────────────────────────────────────────────────
const summary = {
  ts: Date.now(),
  compat,
  dxgiProbeBuilt: !!dxgiExe,
  steps: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
    ok: !v.error && !v.skipped,
    skipped: !!v.skipped,
    reason: v.reason || v.error || undefined,
    rows: v.rows,
    notes: { resolution: v.resolution, rmseVsCpuLinear: v.rmseVsCpuLinear, tiles: v.tiles, capture: v.capture, phaseA: v.phaseA }
  }])),
  leak: totalLeak,
  log: { human: log.logPath, jsonl: log.jsonlPath }
};
log.summary(summary);
log.info("=== run complete ===");
console.log(`\nlogs:\n  ${log.logPath}\n  ${log.jsonlPath}\n  ${log.summaryPath}`);
