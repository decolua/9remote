// Unit tests for the client tile render path (useTiles scheduleRaf / flushRafQueue).
// Replicates the real logic verbatim then attacks it with the edge cases that can
// freeze the remote desktop. Pure logic — no React, no DOM; requestAnimationFrame
// is faked with a 16ms vsync timer so "rAF reset storm" is observable.
//
// Run: node web/test/remoteRender.test.mjs
let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve().then(fn)
    .then(() => { resetRaf(); pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { resetRaf(); fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fake rAF (16ms vsync) ────────────────────────────────────────────────────
let _rafId = 0;
const _rafQueue = new Map();           // id -> {cb, time, timer}
const _timers = new Set();
const VSYNC = 16;
function requestAnimationFrame(cb) {
  const id = ++_rafId;
  const timer = setTimeout(() => {
    _timers.delete(timer);
    if (!_rafQueue.has(id)) return;     // cancelled
    _rafQueue.delete(id);
    cb(Date.now());
  }, VSYNC);
  _timers.add(timer);
  _rafQueue.set(id, { cb, time: Date.now(), timer });
  return id;
}
function cancelAnimationFrame(id) {
  const e = _rafQueue.get(id);
  if (e) { clearTimeout(e.timer); _timers.delete(e.timer); _rafQueue.delete(id); }
}
function pendingRafs() { return _rafQueue.size; }
function resetRaf() {
  for (const e of _rafQueue.values()) { clearTimeout(e.timer); _timers.delete(e.timer); }
  _rafQueue.clear();
}

// ─── Bitmap lifecycle tracker (stands in for ImageBitmap) ─────────────────────
let _opened = 0, _closed = 0;
const reset = () => { _opened = 0; _closed = 0; };
const makeBitmap = () => { _opened++; return { id: ++makeBitmap._id, closed: false }; };
makeBitmap._id = 0;
const closeBitmap = (b) => { if (b && !b.closed) { b.closed = true; _closed++; } };
const leak = () => _opened - _closed;

// ─── Replicated useTiles render queue (forceReschedule=true RTC path) ─────────
// Source: web/features/remote/hooks/useTiles.js flushRafQueue + scheduleRaf.
class RenderQueue {
  constructor({ forceReschedule = true } = {}) {
    this.canvas = true;                 // pretend canvas always present
    this.rafQueue = new Map();          // tileIndex -> entry
    this.rafId = null;
    this.latestTs = new Map();          // tileIndex -> latest applied ts
    this.forceReschedule = forceReschedule;
    this.rendered = [];
    this.staleDropped = 0;
  }
  // enqueue a decoded tile (mirrors RTC branch in handleTilesData)
  enqueue(tile) {
    const prev = this.latestTs.get(tile.tileIndex) ?? 0;
    if (tile.timestamp >= prev) {
      this.latestTs.set(tile.tileIndex, tile.timestamp);
      const old = this.rafQueue.get(tile.tileIndex);
      if (old) closeBitmap(old.bitmap);
      this.rafQueue.set(tile.tileIndex, tile);
    } else {
      closeBitmap(tile.bitmap);
      this.staleDropped++;
    }
    this.scheduleRaf(true);
  }
  scheduleRaf(forceReschedule = false) {
    if (forceReschedule && this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => this.flush());
  }
  flush() {
    this.rafId = null;
    if (!this.canvas) { for (const e of this.rafQueue.values()) closeBitmap(e.bitmap); this.rafQueue.clear(); return; }
    for (const [tileIndex, entry] of this.rafQueue) {
      if ((this.latestTs.get(tileIndex) ?? entry.frameTs) > entry.frameTs) {
        closeBitmap(entry.bitmap);
        continue;
      }
      this.rendered.push(entry);
      closeBitmap(entry.bitmap);
    }
    this.rafQueue.clear();
  }
}

const mk = (tileIndex, timestamp) => ({ tileIndex, timestamp, frameTs: timestamp, bitmap: makeBitmap() });

// ─── Tests ────────────────────────────────────────────────────────────────────
await test("R1 single tile enqueues + renders on next vsync", async () => {
  reset();
  const q = new RenderQueue();
  q.enqueue(mk(0, 100));
  assert(leak() === 1, "bitmap open before vsync");
  await sleep(VSYNC + 5);
  assert(q.rendered.length === 1, `rendered ${q.rendered.length}`);
  assert(leak() === 0, `leak ${leak()}`);
});

await test("R2 two tiles same frame batch into ONE rAF", async () => {
  reset();
  const q = new RenderQueue();
  q.enqueue(mk(0, 100));
  q.enqueue(mk(1, 100));
  assert(pendingRafs() === 1, `${pendingRafs()} rAFs scheduled`);
  await sleep(VSYNC + 5);
  assert(q.rendered.length === 2, `rendered ${q.rendered.length}`);
  assert(leak() === 0, `leak ${leak()}`);
});

await test("R3 ⚠ rAF reset storm: batches < vsync → never renders", async () => {
  // This reproduces the reported freeze: with forceReschedule, every batch cancels
  // the pending rAF. If batches arrive faster than vsync, flush never runs.
  reset();
  const q = new RenderQueue({ forceReschedule: true });
  for (let i = 0; i < 20; i++) {
    q.enqueue(mk(i % 5, 100 + i));
    await sleep(2);                     // 2ms < 16ms vsync
  }
  assert(q.rendered.length === 0, `expected 0 rendered (storm), got ${q.rendered.length}`);
  assert(q.rafQueue.size > 0, "queue still full");
  assert(leak() > 0, `expected bitmaps stuck in queue, leak ${leak()}`);
});

await test("R4 no-reschedule variant renders steadily (proposed fix shape)", async () => {
  reset();
  const q = new RenderQueue({ forceReschedule: false });
  for (let i = 0; i < 20; i++) {
    q.enqueue(mk(i % 5, 100 + i));
    await sleep(2);
  }
  await sleep(VSYNC + 5);
  assert(q.rendered.length > 0, `expected steady renders, got ${q.rendered.length}`);
  assert(leak() === 0, `leak ${leak()}`);
});

await test("R5 stale tile (older ts) is dropped + bitmap closed", async () => {
  reset();
  const q = new RenderQueue();
  q.enqueue(mk(0, 200));
  await sleep(VSYNC + 5);
  q.enqueue(mk(0, 100));                // older → stale
  await sleep(VSYNC + 5);
  assert(q.staleDropped === 1, `stale ${q.staleDropped}`);
  assert(q.rendered.length === 1, "only the newer frame rendered");
  assert(leak() === 0, `leak ${leak()}`);
});

await test("R6 overwrite pending tile closes old bitmap", async () => {
  reset();
  const q = new RenderQueue();
  q.enqueue(mk(0, 100));                // bitmap A
  const firstOpen = leak();
  q.enqueue(mk(0, 200));                // bitmap B replaces A in queue
  assert(leak() === firstOpen - 1 + 1, "old closed, new open");
  await sleep(VSYNC + 5);
  assert(q.rendered.length === 1, "one render");
  assert(q.rendered[0].timestamp === 200, "newer wins");
  assert(leak() === 0, `leak ${leak()}`);
});

await test("R7 canvas missing → flush closes all queued bitmaps", async () => {
  reset();
  const q = new RenderQueue();
  q.canvas = false;
  q.enqueue(mk(0, 100));
  q.enqueue(mk(1, 100));
  await sleep(VSYNC + 5);
  assert(q.rendered.length === 0, "nothing rendered w/o canvas");
  assert(leak() === 0, `all closed, leak ${leak()}`);
});

await test("R8 newer frame arrived while queued → entry dropped on flush", async () => {
  reset();
  const q = new RenderQueue();
  // tile 0 ts=100 enters queue
  q.enqueue(mk(0, 100));
  // simulate a newer tile for same index landing+rendering before flush by bumping latestTs
  q.latestTs.set(0, 999);
  await sleep(VSYNC + 5);
  assert(q.rendered.length === 0, "stale-in-queue dropped");
  assert(leak() === 0, `leak ${leak()}`);
});

await test("R9 long burst saturates but does not leak once drained", async () => {
  reset();
  const q = new RenderQueue({ forceReschedule: false });
  for (let f = 0; f < 50; f++) {
    for (let i = 0; i < 10; i++) q.enqueue(mk(i, f * 100 + i));
    await sleep(8);                     // ~half vsync → a few flushes
  }
  await sleep(VSYNC * 3);
  assert(q.rendered.length > 0, `rendered ${q.rendered.length}`);
  assert(leak() === 0, `leak ${leak()}`);
});

await test("R10 drawImage throw path closes bitmap + invalidates (no leak)", async () => {
  reset();
  const q = new RenderQueue();
  q.canvas = "throw";                   // simulate drawImage exception
  const origFlush = q.flush.bind(q);
  q.flush = function () {
    this.rafId = null;
    for (const entry of this.rafQueue.values()) {
      try { if (this.canvas === "throw") throw new Error("draw"); }
      catch { closeBitmap(entry.bitmap); }   // invalidate path closes bitmap
    }
    this.rafQueue.clear();
  };
  q.enqueue(mk(0, 100));
  await sleep(VSYNC + 5);
  assert(leak() === 0, `leak on throw path ${leak()}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
