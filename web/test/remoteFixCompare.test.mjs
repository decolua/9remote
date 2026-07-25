// Compares 6 fix strategies against the same YouTube-fullscreen storm, with one
// hard rule: when anything has to drop, the NEWEST frame always wins.
//
// Strategies:
//   P0 baseline        — nothing changed (reproduces the freeze)
//   P1 fix rAF storm   — don't cancel a scheduled paint
//   P2 cap worker queue— drop OLDEST batch when queue full (keep newest)
//   P3 lighter agent   — fewer/smaller tiles so the client can keep up
//   P4 P1 + P2         — paint fix + bounded decode queue
//   P5 P1 + P2 + P3    — everything
//
// Run: node web/test/remoteFixCompare.test.mjs
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _opened = 0, _closed = 0;
const reset = () => { _opened = 0; _closed = 0; };
const makeBitmap = () => { _opened++; return { closed: false }; };
const closeBitmap = (b) => { if (b && !b.closed) { b.closed = true; _closed++; } };

class Path {
  constructor(cfg = {}) {
    this.fixRaf = !!cfg.fixRaf;
    this.workerCap = cfg.workerCap ?? Infinity;
    this.rafVsync = cfg.rafVsync ?? 16;
    this.decodeMs = cfg.decodeMs ?? 0.4;     // per-tile decode cost (mock)
    this.mainBlockMs = cfg.mainBlockMs ?? 0;

    this._wp = new Map();                     // id -> {resolve, timer, tiles, ts}
    this._wq = [];
    this._wbusy = false;
    this._msgid = 0;
    this.workerDropped = 0;
    this.workerTimedOut = 0;

    this._pe = null;
    this._flushTimer = null;
    this._latestTs = new Map();

    this._raf = new Map();
    this._rafId = null;
    this._rafScheduled = false;
    this.rafFires = 0;

    this.latencies = [];
    this.rendered = 0;
    this.staleDropped = 0;
    this.latestRenderedTs = -1;
  }

  receiveTile(tiles, ts) {
    const id = ++this._msgid;
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this._wp.has(id)) return;
        this._wp.delete(id); this.workerTimedOut++; resolve(null);
      }, 8000);
      this._wp.set(id, { resolve, timer, tiles, ts });
      if (this._wp.size > this.workerCap) {
        // P2: queue full → drop OLDEST batch (keep newest per the hard rule)
        let oldestId = null, oldestTs = Infinity;
        for (const [eid, e] of this._wp) {
          if (e.ts < oldestTs) { oldestTs = e.ts; oldestId = eid; }
        }
        const old = this._wp.get(oldestId);
        if (old) {
          clearTimeout(old.timer);
          for (const t of old.tiles) closeBitmap(t._bm);
          this._wp.delete(oldestId);
          this.workerDropped++;
          old.resolve(null);
        }
      }
      this._wq.push(id);
      this._pump();
    }).then((ok) => { if (ok) this._onDecoded(tiles, ts); });
  }
  async _pump() {
    if (this._wbusy) return;
    const id = this._wq.shift();
    if (id === undefined) return;
    const entry = this._wp.get(id);
    if (!entry) { if (this._wq.length) this._pump(); return; }
    this._wbusy = true;
    for (const t of entry.tiles) {
      await sleep(this.decodeMs);
      // The batch may have been dropped (queue cap) mid-decode — bail before
      // allocating more bitmaps that nothing will close.
      if (!this._wp.has(id)) { this._wbusy = false; if (this._wq.length) this._pump(); return; }
      t._bm = makeBitmap();
    }
    this._wbusy = false;
    clearTimeout(entry.timer); this._wp.delete(id); entry.resolve(true);
    if (this._wq.length) this._pump();
  }
  _onDecoded(tiles, ts) {
    for (const t of tiles) {
      const prev = this._latestTs.get(t.tileIndex) ?? 0;
      if (ts >= prev) {
        this._latestTs.set(t.tileIndex, ts);
        const old = this._pe?.tiles?.get(t.tileIndex);
        if (old) closeBitmap(old._bm);
        if (!this._pe) this._pe = { tiles: new Map(), ts };
        this._pe.tiles.set(t.tileIndex, t);
        if (ts > this._pe.ts) this._pe.ts = ts;
      } else { closeBitmap(t._bm); this.staleDropped++; }
    }
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this._flush(), 0);
  }
  _flush() {
    this._flushTimer = null;
    if (!this._pe) return;
    if (this.mainBlockMs > 0) { const e = now() + this.mainBlockMs; while (now() < e); }
    const fresh = [...this._pe.tiles.values()];
    this._pe = null;
    for (const t of fresh) {
      const prev = this._raf.get(t.tileIndex);
      if (prev) closeBitmap(prev._bm);
      this._raf.set(t.tileIndex, t);
    }
    this._scheduleRaf(true);
  }
  _scheduleRaf(force) {
    if (this.fixRaf) {
      // P1: once scheduled, DON'T cancel — let vsync fire and batch everything
      if (this._rafScheduled) return;
      this._rafScheduled = true;
      this._rafId = setTimeout(() => {
        this._rafScheduled = false; this._rafId = null; this._rafFlush();
      }, this.rafVsync);
      return;
    }
    if (force && this._rafId) { clearTimeout(this._rafId); this._rafId = null; }
    if (this._rafId) return;
    this._rafId = setTimeout(() => { this._rafId = null; this._rafFlush(); }, this.rafVsync);
  }
  _rafFlush() {
    this.rafFires++;
    const renderTs = now();
    for (const [, t] of this._raf) {
      this.latencies.push(renderTs - t.timestamp);
      this.rendered++;
      if (t.timestamp > this.latestRenderedTs) this.latestRenderedTs = t.timestamp;
      closeBitmap(t._bm);
    }
    this._raf.clear();
  }
  forceStop() {
    for (const { resolve, timer, tiles } of this._wp.values()) {
      clearTimeout(timer); for (const t of tiles) closeBitmap(t._bm); resolve(null);
    }
    this._wp.clear(); this._wq = [];
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (this._rafId) { clearTimeout(this._rafId); this._rafId = null; }
    this._rafScheduled = false;
    if (this._pe) { for (const t of this._pe.tiles.values()) closeBitmap(t._bm); this._pe = null; }
    for (const t of this._raf.values()) closeBitmap(t._bm);
    this._raf.clear();
  }
}

async function runVariant(label, v) {
  reset();
  const path = new Path(v.path);
  const { tilesPerFrame = 260, tilesMod = 260, batchSize = 8, frameMs = 60, durationMs = 4000 } = v.producer;
  const start = now();
  let newestSent = 0;
  while (now() - start < durationMs) {
    const ts = now();
    newestSent = Math.max(newestSent, ts);
    const tiles = [];
    for (let i = 0; i < tilesPerFrame; i++) tiles.push({ tileIndex: i % tilesMod, timestamp: ts });
    for (let i = 0; i < tiles.length; i += batchSize) path.receiveTile(tiles.slice(i, i + batchSize), ts);
    const wait = Math.max(0, frameMs - (now() - start) % frameMs);
    await sleep(Math.min(wait, frameMs));
  }
  await sleep(800);                  // short tail
  path.forceStop();
  const lat = path.latencies.slice().sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.floor(lat.length * 0.95)] : Infinity;
  const max = lat.length ? lat[lat.length - 1] : Infinity;
  return {
    label,
    rendered: path.rendered,
    rafFires: path.rafFires,
    p95Ms: Math.round(p95),
    maxMs: Math.round(max),
    dropped: path.workerDropped,
    stale: path.staleDropped,
    leak: _opened - _closed,
    // 0..1 — how close the newest painted frame is to the newest frame sent
    freshness: newestSent > 0 && path.latestRenderedTs > 0
      ? Math.max(0, Math.min(1, 1 - (newestSent - path.latestRenderedTs) / 1000))
      : 0,
  };
}

const variants = [
  { label: "P0 baseline",        producer: {},                                                        path: {} },
  { label: "P1 fix rAF",         producer: {},                                                        path: { fixRaf: true } },
  { label: "P2 cap queue 24",    producer: {},                                                        path: { workerCap: 24 } },
  { label: "P3 lighter agent",   producer: { tilesPerFrame: 65, tilesMod: 65, frameMs: 60 },          path: {} },
  { label: "P4 P1+P2",           producer: {},                                                        path: { fixRaf: true, workerCap: 24 } },
  { label: "P5 P1+P2+P3",        producer: { tilesPerFrame: 65, tilesMod: 65, frameMs: 60 },          path: { fixRaf: true, workerCap: 24 } },
];

console.log(`\nremoteFixCompare — YouTube fullscreen storm (260 tiles/frame, 16fps)\n`);
const results = [];
for (const v of variants) {
  const r = await runVariant(v.label, v);
  results.push(r);
  console.log(
    `${r.label.padEnd(20)} ` +
    `paint${String(r.rafFires).padStart(5)} ` +
    `ren${String(r.rendered).padStart(6)} ` +
    `${r.maxMs === Infinity ? "  STALL" : `${String(r.maxMs).padStart(6)}ms`} ` +
    `p95${r.p95Ms === Infinity ? " STALL" : `${String(r.p95Ms).padStart(5)}ms`} ` +
    `drop${String(r.dropped).padStart(5)} ` +
    `leak${String(r.leak).padStart(4)} ` +
    `fresh${(r.freshness * 100).toFixed(0).padStart(3)}%`
  );
}

// Rank: leak MUST be 0; then lowest max latency; then highest freshness; then most rendered.
const ranked = results
  .filter((r) => r.leak === 0)
  .map((r) => ({ r, score: -r.maxMs + r.freshness * 500 + Math.min(r.rendered, 5000) / 50 }))
  .sort((a, b) => b.score - a.score);

console.log("\nRanking (leak=0 required):");
if (!ranked.length) console.log("  every variant leaked — investigate");
else ranked.forEach((x, i) => console.log(`  ${i + 1}. ${x.r.label} — max ${x.r.maxMs === Infinity ? "STALL" : x.r.maxMs + "ms"}, freshness ${(x.r.freshness * 100).toFixed(0)}%, ${x.r.rendered} rendered`));
console.log("");
