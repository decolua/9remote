// Coalesce terminal output writes into one term.write per animation frame.
//
// Why: xterm's term.write parses + renders synchronously. Claude Code's TUI streams thousands
// of 1KB chunks/sec; calling term.write on each blocks the main thread and stutters animation /
// corrupts frames. Coalescing into one write per rAF cuts parse/render passes from N to ~60/sec.
//
// Small/interactive chunks (< SMALL_BYTES) write immediately to keep keystroke latency low.
// Larger bursts defer to the next frame. The batcher preserves chunk order and supports both
// Uint8Array and string (xterm accepts both); it also exposes a flush() for join/ack boundaries.
const SMALL_BYTES = 512; // keystroke echo / small prompt updates → write now (no latency cost)

export function createWriteBatcher(term) {
  let queued = [];       // ordered chunks (Uint8Array | string)
  let queuedBytes = 0;
  let rafId = null;

  const flush = () => {
    rafId = null;
    if (!queued.length) return;
    const n = queued.length;
    // If a single chunk, write as-is (no copy). Multiple → concat once into one write.
    if (n === 1) {
      term.write(queued[0]);
    } else {
      // Prefer a single Uint8Array when all chunks are binary; else fall back to string concat.
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
    // Small chunks write immediately only when idle; if a frame is already pending, coalesce into it.
    if (bytes <= SMALL_BYTES && queuedBytes === 0 && rafId === null) {
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
