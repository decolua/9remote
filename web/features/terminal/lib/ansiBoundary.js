// Align a byte/string slice boundary to a clean ANSI escape edge so we never split a trailing
// escape sequence (or UTF-8 codepoint). Used by scroll-up prefix splice on both web + agent UI.

// Trim the END of a Uint8Array down to `keep` bytes, then walk back to the last ESC (0x1b) so the
// retained prefix ends on a complete sequence. Bounded so we never discard a large chunk.
export function trimEndToEsc(u8, keep) {
  if (keep <= 0) return 0;
  if (keep >= u8.byteLength) return u8.byteLength;
  for (let i = keep; i > 0 && keep - i < 512; i--) {
    if (u8[i] === 0x1b) return i;
  }
  return keep;
}
