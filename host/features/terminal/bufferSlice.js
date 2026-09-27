// Pure helpers for slicing a chunked terminal byte buffer (Buffer[]) on clean ANSI boundaries.
// Extracted from ptyDaemon.js so they're unit-testable without importing the daemon (which spawns
// a PTY on load). All boundaries align to ESC (0x1b) so xterm never receives a mid-sequence slice.

// Total byte length of a chunked Buffer[].
export function bufferTotal(chunks) {
  if (!chunks?.length) return 0;
  return chunks.reduce((sum, c) => sum + c.length, 0);
}

// Take up to maxLen bytes from the END of the buffer. The leading byte cut may land mid-ANSI or
// mid-UTF8 → skip forward to the next ESC (bounded ≤512B) so the tail starts on a clean sequence.
export function takeBufferTail(chunks, maxLen) {
  if (!chunks?.length || maxLen <= 0) return Buffer.alloc(0);
  let remaining = maxLen;
  const parts = [];
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = chunks[i];
    if (chunk.length <= remaining) {
      parts.push(chunk);
      remaining -= chunk.length;
    } else {
      parts.push(chunk.subarray(chunk.length - remaining));
      remaining = 0;
    }
  }
  parts.reverse();
  const tail = Buffer.concat(parts);
  if (tail.length > 1 && tail[0] !== 0x1b) {
    const LIMIT = Math.min(tail.length, 512);
    for (let i = 1; i < LIMIT; i++) {
      if (tail[i] === 0x1b) return tail.subarray(i);
    }
  }
  return tail;
}

// Walk absolute offset backward across chunks to the most recent ESC strictly before `fromAbs`,
// bounded so we never extend by more than maxExtend bytes. Returns the ESC abs offset, or
// `fromAbs` unchanged if none found within the window.
export function scanBackForEsc(chunks, fromAbs, maxExtend = 512) {
  if (fromAbs <= 0 || !chunks?.length) return fromAbs;
  // Compute absolute offset of the end of the last chunk, then walk backward.
  let absEnd = 0;
  for (const c of chunks) absEnd += c.length;
  let abs = absEnd;
  let remaining = maxExtend;
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = chunks[i];
    if (chunk.length === 0) { abs -= 0; continue; }
    const chunkAbsStart = abs - chunk.length;
    if (chunkAbsStart >= fromAbs) { abs = chunkAbsStart; continue; }
    // Local upper index: don't scan past fromAbs - 1 (ESC must be strictly before the cut).
    const localHi = Math.min(chunk.length, fromAbs - chunkAbsStart);
    for (let j = localHi - 1; j >= 0 && remaining > 0; j--) {
      if (chunk[j] === 0x1b) return chunkAbsStart + j;
      remaining--;
    }
    abs = chunkAbsStart;
  }
  return fromAbs;
}

// Return up to chunkLen bytes ending at (total - haveFromEnd): the slice just before the tail the
// client already holds (scroll-up fetch). Extend the START backward to the nearest ESC so the
// prefix begins on a clean boundary — no content is discarded. `extra` = bytes extended back.
export function takeBufferRange(chunks, haveFromEnd, chunkLen) {
  if (!chunks?.length || chunkLen <= 0) return { prefix: Buffer.alloc(0), trimmed: 0, extra: 0 };
  const total = bufferTotal(chunks);
  const endExclusive = total - Math.max(0, Math.min(haveFromEnd, total));
  let start = endExclusive - chunkLen;
  if (start < 0) { chunkLen += start; start = 0; }
  if (chunkLen <= 0) return { prefix: Buffer.alloc(0), trimmed: 0, extra: 0 };

  let extra = 0;
  if (start > 0) {
    const escAbs = scanBackForEsc(chunks, start);
    if (escAbs < start) { extra = start - escAbs; start = escAbs; chunkLen += extra; }
  }

  let offset = 0;
  const parts = [];
  for (let i = 0; i < chunks.length && chunkLen > 0; i++) {
    const chunk = chunks[i];
    const next = offset + chunk.length;
    if (next <= start) { offset = next; continue; }
    if (offset >= endExclusive) break;
    const localStart = Math.max(0, start - offset);
    const take = Math.min(chunkLen, chunk.length - localStart);
    parts.push(chunk.subarray(localStart, localStart + take));
    chunkLen -= take;
    offset = next;
  }
  return { prefix: Buffer.concat(parts), trimmed: 0, extra };
}
