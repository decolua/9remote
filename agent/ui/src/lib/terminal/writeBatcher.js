// Coalesce terminal output writes into one term.write per animation frame.
// Parity with web/features/terminal/lib/termWriteBatcher.js — high-frequency PTY output bursts
// (TUI redraws) block the main thread if written chunk-by-chunk; batching cuts it to ~60/sec.
const SMALL_BYTES = 512; // keystroke echo / small updates → write now (no latency cost)

export function createWriteBatcher(term) {
  let queued = [];
  let queuedBytes = 0;
  let rafId = null;

  const flush = () => {
    rafId = null;
    if (!queued.length) return;
    if (queued.length === 1) {
      term.write(queued[0]);
    } else {
      const allBinary = queued.every((c) => c instanceof Uint8Array);
      if (allBinary) {
        const merged = new Uint8Array(queuedBytes);
        let off = 0;
        for (const c of queued) { merged.set(c, off); off += c.length; }
        term.write(merged);
      } else {
        let s = "";
        for (const c of queued) s += typeof c === "string" ? c : new TextDecoder().decode(c);
        term.write(s);
      }
    }
    queued = [];
    queuedBytes = 0;
  };

  const write = (data) => {
    const bytes = data instanceof Uint8Array ? data.length
      : (typeof data === "string" ? data.length : String(data).length);
    if (bytes <= SMALL_BYTES && queuedBytes === 0) {
      term.write(data instanceof Uint8Array || typeof data === "string" ? data : String(data));
      return;
    }
    queued.push(data instanceof Uint8Array || typeof data === "string" ? data : String(data));
    queuedBytes += bytes;
    if (rafId === null) rafId = requestAnimationFrame(flush);
  };

  const dispose = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    queued = [];
    queuedBytes = 0;
  };

  return { write, flush, dispose };
}
