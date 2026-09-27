// Turn a PTY's raw scrollback bytes into the few clean lines a conductor can read.
// The strip is deliberately coarse: colors/cursor moves are noise around a CLI's
// real output. Full-screen TUI apps (vim, htop) still do not read cleanly — that
// is the accepted ceiling; plain CLI output (tests, git, logs) is what this is for.

// CSI sequences, OSC strings, and the odd single-char escapes a terminal emits.
const ESC_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// Remaining control chars — tab, CR and LF are handled separately, everything
// else (bell, backspace, NUL...) carries no text.
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export const TERMINAL_READ_DEFAULT_LINES = 80;

export function cleanTerminalOutput(raw, { maxLines = TERMINAL_READ_DEFAULT_LINES, maxBytes = 16 * 1024 } = {}) {
  const text = String(raw || "")
    .replace(ESC_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(CTRL_RE, "");
  const lines = [];
  for (const line of text.split("\n")) {
    // Blank and space-only lines are layout, not content — dropped entirely, so
    // the tail a conductor reads is dense instead of mostly air.
    const clean = line.trim();
    if (!clean) continue;
    lines.push(clean);
  }
  let out = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  let result = out.join("\n");
  if (Buffer.byteLength(result) > maxBytes) {
    // Keep the newest bytes, then resume at a line boundary so no half-line leads.
    result = result.slice(-maxBytes);
    const nl = result.indexOf("\n");
    if (nl >= 0) result = result.slice(nl + 1);
  }
  return result;
}
