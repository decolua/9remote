// Simulates the client tile-receive path to find the remote-desktop stall cause.
// Mirrors real code:
//   tileDecoder.worker.js        -> DecodeWorkerSim (single-thread serial decode)
//   WebRtcProtocol._receiveTile  -> receiveTile() (worker queue + 8s timeout)
//   WebRtcProtocol flush         -> pendingEmit + setTimeout(0) flush (reset-per-batch)
//   useTiles scheduleRaf/flush   -> rafQueue + rAF (reset-per-batch, drawImage)
//
// Run: node web/test/remoteDecodeBacklog.test.mjs
// Fast mode (skip real decode): node web/test/remoteDecodeBacklog.test.mjs --mock
import sharp from "sharp";

const MOCK = process.argv.includes("--mock");

// ─── Sample WebP tile (128×128, ~typical agent output) ─────────────────────────
const SAMPLE_WEBP = await sharp({
  create: { width: 128, height: 128, channels: 3, background: { r: 128, g: 60, b: 40 } }
}).webp({ quality: 65 }).toBuffer();

async function decodeOne() {
  if (MOCK) { await sleep(0.4); return; }
  await sharp(SAMPLE_WEBP).raw().toBuffer({ resolveWithObject: false });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function now() { return performance.now(); }

// Bitmap leak tracker (stands in for createImageBitmap / ImageBitmap.close())
let _opened = 0, _closed = 0;
const makeBitmap = () => { _opened++; return { id: ++makeBitmap._id, closed: false }; };
makeBitmap._id = 0;
const closeBitmap = (b) => { if (b && !b.closed) { b.closed = true; _closed++; } };
const resetBitmapCounters = () => { _opened = 0; _closed = 0; makeBitmap._id = 0; };

// ─── Client receive path ──────────────────────────────────────────────────────
class ClientReceivePath {
  constructor(opts = {}) {
    this.workerTimeoutMs = opts.workerTimeoutMs ?? 8000;
    this.workerCap = opts.workerCap ?? Infinity;       // T2: drop when queue full
    this.workerHang = opts.workerHang ?? false;        // T9: iOS suspend
    this.mainBlockMs = opts.mainBlockMs ?? 0;          // T4: main-thread CPU per flush
    this.drawMs = opts.drawMs ?? 0;                    // T6: drawImage cost per tile
    this.flushResetGapMs = opts.flushResetGapMs ?? 0;  // <0 => storm (T5)

    // Stage 1: worker (mirrors _workerPending + serial worker)
    this._wp = new Map();      // id -> {resolve, timer}
    this._wq = [];             // FIFO of ids
    this._wbusy = false;
    this._msgid = 0;
    this.workerDropped = 0;
    this.workerTimedOut = 0;

    // Stage 2: pendingEmit + flush setTimeout(0) (mirrors WebRtcProtocol._receiveTile)
    this._pe = null;
    this._flushTimer = null;
    this._latestTs = new Map();
    this.flushCount = 0;

    // Stage 3: rafQueue + rAF (mirrors useTiles.scheduleRaf(true) + flushRafQueue)
    this._raf = new Map();
    this._rafId = null;
    this.rafFires = 0;

    // Metrics
    this.latencies = [];       // end-to-end ts -> render
    this.queueSamples = [];    // worker queue size over time
    this.rafSamples = [];
    this.rendered = 0;
    this.staleDropped = 0;
    this._t0 = now();
  }

  // Producer entry: one binary batch of N tiles (like one RTC binary message)
  // Tiles carry no bitmap yet — bitmaps are created at decode time (mirrors worker
  // createImageBitmap), so leak accounting only counts decoded-but-unclosed bitmaps.
  receiveTile(tiles, timestamp) {
    const id = ++this._msgid;
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this._wp.has(id)) return;
        this._wp.delete(id);
        this.workerTimedOut++;
        resolve(null);
      }, this.workerTimeoutMs);
      this._wp.set(id, { resolve, timer, tiles });
      if (this.workerHang) return;          // worker never picks up -> timeout path
      if (this._wp.size > this.workerCap) { // T2 cap drop (newest batch discarded)
        this.workerDropped++;
        clearTimeout(timer); this._wp.delete(id);
        resolve(null);
        return;
      }
      this._wq.push(id);
      this._pumpWorker();
    }).then((result) => {
      if (!result) return;
      this._onDecoded(tiles, timestamp);
    });
  }

  async _pumpWorker() {
    if (this._wbusy) return;
    const id = this._wq.shift();
    if (id === undefined) return;
    const entry = this._wp.get(id);
    if (!entry) { if (this._wq.length) this._pumpWorker(); return; }
    this._wbusy = true;
    // Decode every tile in the batch serially (single worker thread) + create bitmap
    for (const t of entry.tiles) { await decodeOne(); t._bm = makeBitmap(); }
    this._wbusy = false;
    clearTimeout(entry.timer); this._wp.delete(id); entry.resolve(true);
    if (this._wq.length) this._pumpWorker();
  }

  // Stage 2: pendingEmit accumulate + flush (reset-per-batch like real code)
  _onDecoded(tiles, timestamp) {
    for (const t of tiles) {
      const prev = this._latestTs.get(t.tileIndex) ?? 0;
      if (timestamp >= prev) {
        this._latestTs.set(t.tileIndex, timestamp);
        const old = this._pe?.tiles?.get(t.tileIndex);
        if (old) closeBitmap(old._bm);
        if (!this._pe) this._pe = { tiles: new Map(), timestamp };
        this._pe.tiles.set(t.tileIndex, t);
        if (timestamp > this._pe.timestamp) this._pe.timestamp = timestamp;
      } else {
        closeBitmap(t._bm);
        this.staleDropped++;
      }
    }
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this._flush(), this.flushResetGapMs < 0 ? 0 : 0);
  }

  _flush() {
    this._flushTimer = null;
    if (!this._pe) return;
    // T4: simulate main-thread blocked by React/input work before flush runs
    if (this.mainBlockMs > 0) busyBlock(this.mainBlockMs);
    const fresh = [...this._pe.tiles.values()];
    this._pe = null;
    this.flushCount++;
    for (const t of fresh) {
      // Stage 3: enqueue into rafQueue (forceReschedule = cancel + reschedule)
      const prev = this._raf.get(t.tileIndex);
      if (prev) closeBitmap(prev._bm);
      this._raf.set(t.tileIndex, t);
    }
    if (this._rafId) { clearTimeout(this._rafId); this._rafId = null; }
    this._rafId = setTimeout(() => this._rafFlush(), 16);
  }

  _rafFlush() {
    this._rafId = null;
    this.rafFires++;
    if (this.drawMs > 0) busyBlock(this.drawMs * this._raf.size); // sync drawImage cost
    const renderTs = now();
    for (const [, t] of this._raf) {
      this.latencies.push(renderTs - t.timestamp);
      this.rendered++;
      closeBitmap(t._bm);
    }
    this._raf.clear();
  }

  sample(nowMs) {
    this.queueSamples.push({ t: nowMs - this._t0, q: this._wp.size });
    this.rafSamples.push({ t: nowMs - this._t0, r: this._raf.size });
  }

  // Force-drop everything still in-flight so the scenario ends promptly.
  // Bitmaps in pending tiles are closed to keep leak accounting honest.
  forceStop() {
    for (const { resolve, timer } of this._wp.values()) {
      clearTimeout(timer); resolve(null);
    }
    this._wp.clear(); this._wq = [];
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (this._rafId) { clearTimeout(this._rafId); this._rafId = null; }
    if (this._pe) { for (const t of this._pe.tiles.values()) closeBitmap(t._bm); this._pe = null; }
    for (const t of this._raf.values()) closeBitmap(t._bm);
    this._raf.clear();
  }
}

function busyBlock(ms) { const end = now() + ms; while (now() < end); }

// ─── Producer: mimics agent streamLoop over RTC ───────────────────────────────
async function runScenario(cfg) {
  resetBitmapCounters();
  const path = new ClientReceivePath(cfg.path);
  const {
    durationMs = 2000,
    tilesPerFrame = 120,      // scaled down from 260 (still > decode capacity at 16fps)
    tilesMod = 120,
    batchSize = 8,            // dcChunkSize
    frameMs = 60,             // activeInterval target
    producerBlockMs = 0,      // T11: agent keeps producing regardless of client
  } = cfg.producer || {};

  const sampler = setInterval(() => path.sample(now()), 100);
  const start = now();

  while (now() - start < durationMs) {
    const frameStart = now();
    const ts = now();
    const tiles = [];
    for (let i = 0; i < tilesPerFrame; i++) {
      tiles.push({ tileIndex: i % tilesMod, timestamp: ts });
    }
    for (let i = 0; i < tiles.length; i += batchSize) {
      path.receiveTile(tiles.slice(i, i + batchSize), ts);
      if (producerBlockMs > 0) busyBlock(producerBlockMs);
    }
    const elapsed = now() - frameStart;
    const wait = Math.max(0, frameMs - elapsed);
    await sleep(wait > 0 ? wait : 0);
  }

  // Short tail: let a little drain, then force-stop the rest.
  await sleep(1000);
  clearInterval(sampler);
  path.forceStop();

  return summarize(path, cfg.name);
}

function summarize(p, name) {
  const lat = p.latencies;
  lat.sort((a, b) => a - b);
  const maxQ = p.queueSamples.reduce((m, s) => Math.max(m, s.q), 0);
  const maxR = p.rafSamples.reduce((m, s) => Math.max(m, s.r), 0);
  const leak = _opened - _closed;
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
  const p95 = lat.length ? lat[Math.floor(lat.length * 0.95)] : 0;
  const maxLat = lat.length ? lat[lat.length - 1] : Infinity; // 0 rendered = never painted = ∞ latency
  return {
    name,
    rendered: p.rendered,
    stalled: lat.length === 0,                 // no tile ever painted
    maxLatencyMs: maxLat,
    p50Ms: p50,
    p95Ms: p95,
    maxWorkerQueue: maxQ,
    maxRafQueue: maxR,
    workerDrops: p.workerDropped,
    workerTimeouts: p.workerTimedOut,
    staleDrops: p.staleDropped,
    flushes: p.flushCount,
    rafFires: p.rafFires,
    bitmapLeak: leak,
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────────
const LATENCY_FAIL = 1000; // >1s end-to-end = visible stall
function verdict(r) {
  const stalled = r.stalled || r.maxLatencyMs > LATENCY_FAIL;
  const leaking = r.bitmapLeak > 0;
  return { stalled, leaking, suspect: stalled || leaking };
}

function fmtLat(ms) { return ms === Infinity ? "  STALL" : `${String(Math.round(ms)).padStart(6)}ms`; }

function printRow(r) {
  const v = verdict(r);
  const flag = v.suspect ? "⚠ SUSPECT" : "ok";
  console.log(
    `${r.name.padEnd(34)} ${fmtLat(r.maxLatencyMs)} ${fmtLat(r.p95Ms)} ` +
    `q${String(r.maxWorkerQueue).padStart(5)} ` +
    `raf${String(r.maxRafQueue).padStart(5)} ` +
    `drop${String(r.workerDrops).padStart(5)} ` +
    `to${String(r.workerTimeouts).padStart(4)} ` +
    `leak${String(r.bitmapLeak).padStart(5)} ` +
    `ren${String(r.rendered).padStart(6)}  ${flag}`
  );
}

// ─── Scenarios (11 cases) ─────────────────────────────────────────────────────
const base = { tilesPerFrame: 120, tilesMod: 120, batchSize: 8, frameMs: 60, durationMs: 2000 };
const scenarios = [
  { name: "T1 baseline (no limit)",       producer: { ...base },                              path: {} },
  { name: "T2 worker cap=16",             producer: { ...base },                              path: { workerCap: 16 } },
  { name: "T3 burst first-frame",         producer: { ...base, frameMs: 0, durationMs: 1200 }, path: {} },
  { name: "T4 main-thread block 150ms",   producer: { ...base },                              path: { mainBlockMs: 150 } },
  { name: "T5 flush reset storm",         producer: { ...base, frameMs: 0, durationMs: 1500 }, path: {} },
  { name: "T6 slow drawImage 3ms/tile",   producer: { ...base },                              path: { drawMs: 3 } },
  { name: "T7 stale drop correctness",    producer: { tilesPerFrame: 40, tilesMod: 40, batchSize: 8, frameMs: 50, durationMs: 2000 }, path: {} },
  { name: "T8 overwrite no-leak",         producer: { tilesPerFrame: 8, tilesMod: 8, batchSize: 8, frameMs: 16, durationMs: 2000 }, path: {} },
  { name: "T9 worker hang (iOS)",         producer: { ...base, durationMs: 3000 },            path: { workerHang: true, workerTimeoutMs: 1000 } },
  { name: "T10 worker terminate mid",     producer: { ...base, durationMs: 2000 },            path: { workerHang: true, workerTimeoutMs: 60000 } },
  { name: "T11 no backpressure fb",       producer: { ...base, frameMs: 0, durationMs: 1500 }, path: {} },
];

console.log(`\nremoteDecodeBacklog test — ${MOCK ? "MOCK decode" : "real sharp decode"}\n`);
console.log(
  `${"scenario".padEnd(34)} ${"maxLat".padStart(7)} ${"p95".padStart(7)} ` +
  `${"wQueue".padStart(6)} ${"rafQ".padStart(6)} ${"drops".padStart(6)} ${"tmo".padStart(5)} ${"leak".padStart(6)} ${"rendered".padStart(9)}  verdict`
);

const results = [];
for (const s of scenarios) {
  const r = await runScenario(s);
  results.push(r);
  printRow(r);
}

console.log("\nVerdict:");
const suspects = results.filter((r) => verdict(r).suspect);
if (suspects.length === 0) {
  console.log("  No scenario exceeded 1s latency, stalled, or leaked bitmaps.");
} else {
  console.log(`  ${suspects.length} scenario(s) match the reported stall / freeze:\n`);
  for (const r of suspects) {
    const why = [];
    if (r.stalled) why.push(`never painted (0 rendered)`);
    else if (r.maxLatencyMs > LATENCY_FAIL) why.push(`latency ${Math.round(r.maxLatencyMs)}ms`);
    if (r.bitmapLeak > 0) why.push(`bitmap leak ${r.bitmapLeak}`);
    if (r.maxWorkerQueue > 50) why.push(`worker queue peaked ${r.maxWorkerQueue}`);
    if (r.maxRafQueue > 50) why.push(`raf queue peaked ${r.maxRafQueue}`);
    if (r.workerTimeouts > 0) why.push(`${r.workerTimeouts} worker timeouts`);
    console.log(`    • ${r.name}: ${why.join(", ")}`);
  }
}
console.log("");
