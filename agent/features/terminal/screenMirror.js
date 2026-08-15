// A small tail of each session's recent PTY output, kept on the agent side.
//
// The chat GUI must see what is really on screen before injecting a keystroke. The daemon
// holds the full scrollback, but asking it would mean a daemon protocol change — and that
// bumps DAEMON_VERSION, which kills every running terminal on upgrade. The agent already
// receives every output frame on its way to the browser, so it can mirror the tail for free.
//
// Only the tail matters: this answers "is the selector on screen right now", never history.
export const MIRROR_MAX_BYTES = 8_192;

// sessionId → recent output text
const mirrors = new Map();

// Sequences after which nothing written earlier is on the display any more:
//   ESC[2J / ESC[3J — erase the whole screen
//   ESC[J / ESC[0J  — erase from the cursor to the end
//   ESC[?1049l/?1047l — leave the alternate screen a full-screen TUI was drawing on
// Without honouring these the mirror is an append-only log, and an answered prompt would
// look like it is still waiting forever.
const CLEAR_RE = /\x1b\[[0-3]?J|\x1b\[\?104[79]l/g;

// Keep only what was written after the last clear in this frame.
function afterLastClear(text) {
  let cut = -1;
  CLEAR_RE.lastIndex = 0;
  for (let m = CLEAR_RE.exec(text); m; m = CLEAR_RE.exec(text)) cut = m.index + m[0].length;
  return cut === -1 ? null : text.slice(cut);
}

/** Append one output frame. `enc` is "b64" when the daemon forwarded base64 untouched. */
export function recordOutput(sessionId, data, enc) {
  if (!sessionId || data == null) return;

  let text;
  if (Buffer.isBuffer(data)) text = data.toString("utf8");
  else if (enc === "b64") text = Buffer.from(String(data), "base64").toString("utf8");
  else text = String(data);
  if (!text) return;

  const tailAfterClear = afterLastClear(text);
  const prev = tailAfterClear === null ? (mirrors.get(sessionId) || "") : "";
  const next = prev + (tailAfterClear === null ? text : tailAfterClear);
  mirrors.set(sessionId, next.length > MIRROR_MAX_BYTES ? next.slice(-MIRROR_MAX_BYTES) : next);
}

/** Recent output for a session, raw — ANSI intact, for the caller to strip. */
export function readScreen(sessionId) {
  return mirrors.get(sessionId) || "";
}

export function forgetScreen(sessionId) {
  if (!sessionId) return;
  mirrors.delete(sessionId);
}

export function _resetForTest() {
  mirrors.clear();
}
