// Reads xterm's buffer into plain lines with their colour runs.
//
// The browser already owns the exact terminal: xterm parsed every escape sequence the
// moment it rendered. Reading it back costs nothing and keeps what a raw-byte parser
// throws away — colour, which CLI TUIs use to mark roles more consistently than glyphs.
//
// "term" is anything shaped like an xterm instance (buffer.active.{length,getLine}),
// so tests substitute a plain object.

// The reader must never pin the tab on a huge scrollback — the newest lines are the ones
// the chat view needs.
const DEFAULT_MAX_LINES = 400;

export class XtermScreenReader {
  constructor(term, { maxLines = DEFAULT_MAX_LINES } = {}) {
    this.term = term;
    this.maxLines = maxLines;
  }

  /** @returns {{ text, fgRuns: {fg, text}[], isWrapped }[]} */
  readLines() {
    const buffer = this.term?.buffer?.active;
    if (!buffer || typeof buffer.getLine !== "function") return [];

    const total = buffer.length;
    const start = Math.max(0, total - this.maxLines);
    const lines = [];
    for (let y = start; y < total; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      lines.push(this.readLine(line));
    }
    return lines;
  }

  readLine(line) {
    const cells = [];
    // xterm sets .length; a test double may only expose translateToString.
    const width = typeof line.length === "number"
      ? line.length
      : (typeof line.translateToString === "function" ? (line.translateToString(false) || "").length : 0);
    for (let x = 0; x < width; x++) {
      const cell = line.getCell?.(x);
      cells.push({
        ch: cell?.getChars?.() ?? (cell && typeof cell.ch === "string" ? cell.ch : "") ?? "",
        fg: this.fgOf(cell),
      });
    }
    const text = cells.map((c) => c.ch).join("").replace(/\s+$/, "");
    return { text, fgRuns: runsFromCells(cells, text), isWrapped: !!line.isWrapped };
  }

  // Normalise xterm's colour API (palette index / RGB / default) into a plain value a
  // profile can compare with ===. null = terminal default colour.
  fgOf(cell) {
    if (!cell) return null;
    if (typeof cell.isFgDefault === "function" && cell.isFgDefault()) return null;
    if (typeof cell.getFg === "function" && cell.getFg() != null) return cell.getFg();
    return cell.fg ?? null;
  }
}

function runsFromCells(cells, trimmedText) {
  const used = trimmedText.length;
  const runs = [];
  let current = null;
  for (let i = 0; i < used; i++) {
    const fg = cells[i]?.fg ?? null;
    if (current && current.fg === fg) current.text += cells[i].ch;
    else {
      current = { fg, text: cells[i].ch };
      runs.push(current);
    }
  }
  return runs;
}
