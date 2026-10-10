// Soft-keyboard stage lock for the browser pane — pure state machine, no DOM.
// Ported from TerminalPane's fixed-height pattern: while the on-screen keyboard
// shrinks the viewport (same width, height drops), the stage keeps its
// keyboard-closed height so the stream canvas stays full-size above the
// keyboard. The screencast restart decision sees only TRUE (keyboard-closed)
// sizes, so a keyboard cycle never restarts the stream.

export const KB_SHRINK_THRESHOLD = 8; // px drop that means "keyboard", not jitter
export const KB_CLOSE_TOLERANCE = 2; // px slack reading "closed again"
export const STREAM_RESTART_SLACK = 24; // px of true-size change worth a restart

export function nextStageLock(prev, { w, h }) {
  // First observation, or width change (rotation/split): re-seed, keyboard state reset
  if (!prev || w !== prev.width) {
    return { width: w, height: h, lockedH: null, kbShrunk: false };
  }
  if (h >= prev.height - KB_CLOSE_TOLERANCE) {
    // Closed again (or genuinely grew: fullscreen) — keep the max, never ratchet down
    return { width: w, height: Math.max(h, prev.height), lockedH: null, kbShrunk: false };
  }
  if (h < prev.height - KB_SHRINK_THRESHOLD) {
    // Soft keyboard opened — true size stays the closed height
    return { width: w, height: prev.height, lockedH: prev.height, kbShrunk: true };
  }
  return prev; // sub-threshold jitter
}

export function shouldRestartStream(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.w - b.w) + Math.abs(a.h - b.h) > STREAM_RESTART_SLACK;
}
