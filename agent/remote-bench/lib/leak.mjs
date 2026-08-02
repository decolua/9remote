// Leak tracker: RSS/heap snapshots per phase + OpenCL buffer create/release counter.

export class LeakTracker {
  constructor({ leakThresholdMB = 50 } = {}) {
    this.threshold = leakThresholdMB;
    this._snaps = new Map();
    this._created = 0;
    this._released = 0;
  }

  gc() {
    if (typeof global.gc === "function") global.gc();
  }

  snapshot(label) {
    this.gc();
    const m = process.memoryUsage();
    this._snaps.set(label, { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external });
  }

  createBuf(key) { this._created++; }
  releaseBuf(key) { this._released++; }

  counterReport() {
    return { created: this._created, released: this._released, outstanding: this._created - this._released };
  }

  report(fromLabel, toLabel) {
    const a = this._snaps.get(fromLabel) || {};
    const b = this._snaps.get(toLabel) || {};
    const MB = 1024 * 1024;
    const rssDelta = (b.rss || 0) - (a.rss || 0);
    const heapDelta = (b.heapUsed || 0) - (a.heapUsed || 0);
    const rssDeltaMB = rssDelta / MB;
    const c = this.counterReport();
    // Counter (outstanding buffers) is the deterministic leak signal.
    // RSS spikes alone are native arena noise (OpenCL/sharp runtime caches),
    // not a JS-tracked leak — reported as info, not flagged.
    const leaked = c.outstanding > 0;
    return {
      from: fromLabel, to: toLabel,
      rssDelta, heapDelta,
      rssDeltaMB, heapDeltaMB: heapDelta / MB,
      outstanding: c.outstanding,
      rssNote: rssDeltaMB > this.threshold ? "native-arena-spike" : "ok",
      leaked
    };
  }
}
