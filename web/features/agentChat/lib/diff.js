// Line diff for the Edit/Write tool cards. Emits ONLY changed lines — no context rows,
// so a one-line edit in a 500-line file renders two rows, not 500.

// "" splits to [""] — an empty file has zero lines, not one blank one, or creating a file
// would show a phantom leading blank addition.
const splitLines = (text) => {
  if (text == null || text === "") return [];
  const lines = String(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Changed lines between two texts, as [{ type: "added"|"removed", content, lineNum }]. */
export function computeDiff(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0 && b.length === 0) return [];

  // LCS table over lines; the walk back reads out only the non-matching runs.
  const m = a.length;
  const n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: "removed", content: a[i], lineNum: ++i });
    else out.push({ type: "added", content: b[j], lineNum: ++j });
  }
  while (i < m) out.push({ type: "removed", content: a[i], lineNum: ++i });
  while (j < n) out.push({ type: "added", content: b[j], lineNum: ++j });
  return out;
}

/** computeDiff memoised on the (old, new) pair, bounded so long sessions cannot leak. */
export function createCachedDiff(limit = 100) {
  const cache = new Map();
  const fn = (oldText, newText) => {
    const key = JSON.stringify([oldText ?? "", newText ?? ""]);
    if (cache.has(key)) return cache.get(key);
    const value = computeDiff(oldText, newText);
    cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value);
    return value;
  };
  fn.size = () => cache.size;
  return fn;
}
