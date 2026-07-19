// Split a terminal mirror (mixed Uint8Array | string chunks) into byte-bounded
// chunks for incremental xterm.write. xterm.js parses asynchronously in ~12ms
// batches and preserves ANSI/UTF-8 parser state across writes, so feeding a
// big replay in ≤maxBytes pieces (via write callback + rAF) keeps the main
// thread responsive instead of blocking on one MB-sized write.
//
// Byte order is preserved exactly; multibyte UTF-8 codepoints may be split
// across chunk boundaries (xterm reassembles them via its decoder state).

const _enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const byteLen = (c) =>
  c instanceof Uint8Array ? c.length
    : (typeof c === "string" ? (_enc ? _enc.encode(c).length : Buffer.byteLength(c, "utf-8")) : 0);

// Push the next `n` bytes from `src` (Uint8Array | string) starting at offset
// into `out`, returning the number of bytes consumed from src.
function pushBytes(out, src, offset, n) {
  if (src instanceof Uint8Array) {
    out.push(src.subarray(offset, offset + n));
    return n;
  }
  // String: encode once to bytes, slice bytes, keep as Uint8Array to avoid
  // re-splitting multibyte chars (string slicing by byte count is unsafe).
  const bytes = _enc ? _enc.encode(src) : Uint8Array.from(Buffer.from(src, "utf-8"));
  out.push(bytes.subarray(offset, offset + n));
  return n;
}

// mirror: array of Uint8Array | string. maxBytes: max byte length per output chunk.
// Returns array of Uint8Array (byte-sliced from inputs, order preserved).
export function toReplayChunks(mirror, maxBytes) {
  if (!Array.isArray(mirror) || mirror.length === 0) return [];
  const cap = maxBytes > 0 ? Math.floor(maxBytes) : 1;
  const out = [];
  const buf = new Uint8Array(cap);
  let bufLen = 0;

  const flush = () => {
    if (bufLen === 0) return;
    out.push(bufLen === cap ? buf.slice() : buf.subarray(0, bufLen).slice());
    bufLen = 0;
  };

  for (const item of mirror) {
    if (item == null) continue;
    const src = item instanceof Uint8Array ? item
      : (typeof item === "string" ? (_enc ? _enc.encode(item) : Uint8Array.from(Buffer.from(item, "utf-8")))
        : null);
    if (!src || src.length === 0) continue;
    let off = 0;
    while (off < src.length) {
      const room = cap - bufLen;
      const take = Math.min(room, src.length - off);
      buf.set(src.subarray(off, off + take), bufLen);
      bufLen += take;
      off += take;
      if (bufLen >= cap) flush();
    }
  }
  flush();
  return out;
}
