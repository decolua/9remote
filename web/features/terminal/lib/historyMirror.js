import { trimEndToEsc } from "@/features/terminal/lib/ansiBoundary";

// Byte length of a string in UTF-8 — matches the daemon's Buffer byte count so `have`/`total`
// stay consistent across multibyte output.
const _utf8Encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
export function utf8ByteLength(str) {
  if (!str) return 0;
  if (_utf8Encoder) return _utf8Encoder.encode(str).length;
  return Buffer.byteLength(str, "utf-8"); // node fallback
}

// Normalize a payload to Uint8Array or string — the two forms the mirror stores.
export function toChunk(data) {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }
  return typeof data === "string" ? data : String(data);
}

export const chunkByteLength = (chunk) =>
  typeof chunk === "string" ? utf8ByteLength(chunk) : chunk.byteLength;

// Write output via the rAF batcher when provided (coalesces bursts into one write/frame so the
// main thread isn't blocked parsing each 1KB chunk), else direct term.write. mirror/mirrorBytes:
// refs accumulating raw bytes for scroll-up history replay (null = skip mirroring).
export function writeChunked(term, data, mirror, mirrorBytes, batcher) {
  if (!term || term._core?._isDisposed) return;
  const chunk = toChunk(data);
  if (batcher) batcher.write(chunk);
  else term.write(chunk);

  if (mirror) {
    mirror.current.push(chunk);
    mirrorBytes.current += chunkByteLength(chunk);
  }
}

// Race-dedup for a scroll-up prefix: the daemon computes the range against the `have` we SENT,
// but live PTY output can land in our tail between emit and ack → the prefix's tail re-covers
// bytes already mirrored. Drop that overlap, aligning any byte cut to a clean ESC boundary so
// a trailing ANSI escape isn't split.
export function dedupePrefix(prefixChunk, { haveAtEmit, historyBytes }) {
  const liveDelta = Math.max(0, haveAtEmit > 0 ? historyBytes - haveAtEmit : 0);
  if (liveDelta <= 0) return prefixChunk;
  let keep = Math.max(0, chunkByteLength(prefixChunk) - liveDelta);
  if (typeof prefixChunk !== "string") keep = trimEndToEsc(prefixChunk, keep);
  return typeof prefixChunk === "string" ? prefixChunk.slice(0, keep) : prefixChunk.subarray(0, keep);
}

// Scroll offset that keeps the user's content in place after a prefix replay. We MEASURE the
// prefix's real line count (baseY delta) instead of estimating from bytes — ANSI escapes and
// wide-char wrapping make byte/cols estimates wildly wrong → viewport jump. Negative = scroll up.
export function viewportRestoreDelta({ oldViewportY, baseYBefore, baseYAfter }) {
  const actualChunkLines = Math.max(0, baseYAfter - baseYBefore);
  const target = Math.max(0, Math.min(oldViewportY + actualChunkLines, baseYAfter));
  return target - baseYAfter;
}

// Decode the mirror into one writable string (stream mode keeps multibyte chars split
// across chunk boundaries intact).
export function decodeMirror(chunks) {
  const decoder = new TextDecoder();
  return chunks.map((c) => (typeof c === "string" ? c : decoder.decode(c, { stream: true }))).join("");
}
