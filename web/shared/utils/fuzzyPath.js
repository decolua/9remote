"use client";

// Ranking for `@` file mentions (AI composer) and the terminal path hint. The scorer
// follows fzf v2 — per-character match, gap penalties, boundary and run bonuses — and
// adds one path-only rule: a hit on the basename always outranks a hit that only
// lands on parent folders. Everything runs locally on a cached path list, so typing
// never waits on a round-trip.

export const FUZZY_PATH = {
  charScore: 16,
  gapStart: -3,
  gapExtend: -1,
  bonusBoundary: 8,
  bonusWhitespace: 10,
  bonusDelimiter: 9,
  bonusCamel: 7,
  bonusConsecutive: 4,
  firstCharBonusMultiplier: 2,
  basenameMatchBonus: 200,
  dirOnlyPenalty: 0.6,
  exactBasenameBonus: 120,
  prefixBasenameBonus: 60,
  prefixDirBonus: 80,
  modifiedBonus: 15,
  depthPenalty: 2,
  maxDepthPenalty: 12,
  debounceMs: 100,
  maxResults: 10
};

const NEG = -1e9;

// Scratch matrices reused across candidates: a keystroke scores every path.
let scratchSize = 0;
let scoreGrid = null;
let gapGrid = null;
let srcGrid = null;
let bonusRow = null;

function ensureScratch(cells, textLength) {
  if (cells > scratchSize) {
    scoreGrid = new Float64Array(cells);
    gapGrid = new Float64Array(cells);
    srcGrid = new Uint8Array(cells);
    scratchSize = cells;
  }
  if (!bonusRow || bonusRow.length < textLength) bonusRow = new Float64Array(textLength);
}

// Bonus for a match that lands on `index`, mirroring fzf's boundary weights.
function boundaryBonus(text, index) {
  if (index === 0) return FUZZY_PATH.bonusWhitespace;
  const prev = text[index - 1];
  if (prev === "/" || prev === "\\") return FUZZY_PATH.bonusDelimiter;
  if (prev === " " || prev === "\t") return FUZZY_PATH.bonusWhitespace;
  if (prev === "." || prev === "-" || prev === "_") return FUZZY_PATH.bonusBoundary;
  const cur = text[index];
  if (prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z") return FUZZY_PATH.bonusCamel;
  return 0;
}

function fillBonusRow(text, length) {
  for (let i = 0; i < length; i++) bonusRow[i] = boundaryBonus(text, i);
}

// Smart case: a query with capitals is matched case-sensitively.
function isCaseSensitive(query) {
  return /[A-Z]/.test(query);
}

// Cheap O(n) gate: most candidates fail here, before paying for the DP.
function hasSubsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

// Best alignment of `query` inside `text`. Returns the score and the matched
// offsets (for highlighting), or null when the characters are not all present.
export function scoreText(query, text) {
  if (!query) return { score: 0, positions: [] };
  if (!text || query.length > text.length) return null;

  const sensitive = isCaseSensitive(query);
  const needle = sensitive ? query : query.toLowerCase();
  const hay = sensitive ? text : text.toLowerCase();
  if (!hasSubsequence(needle, hay)) return null;

  const m = needle.length;
  const n = hay.length;
  const width = n + 1;
  const cells = (m + 1) * width;
  ensureScratch(cells, n);
  scoreGrid.fill(NEG, 0, cells);
  gapGrid.fill(NEG, 0, cells);
  srcGrid.fill(0, 0, cells);
  fillBonusRow(text, n);
  // Row 0 is the empty prefix: every position scores 0 with no gap open.
  for (let j = 0; j <= n; j++) scoreGrid[j] = 0;

  for (let i = 1; i <= m; i++) {
    const qc = needle.charCodeAt(i - 1);
    const row = i * width;
    const prevRow = row - width;
    const first = i === 1;

    for (let j = i; j <= n; j++) {
      const cell = row + j;
      const left = cell - 1;
      let match = NEG;

      if (hay.charCodeAt(j - 1) === qc) {
        const prev = scoreGrid[prevRow + j - 1];
        if (prev > NEG / 2) {
          // srcGrid === 1 means the previous row ends exactly at j-1 → adjacent run.
          const chained = i > 1 && srcGrid[prevRow + j - 1] === 1;
          let bonus = bonusRow[j - 1];
          if (first) bonus *= FUZZY_PATH.firstCharBonusMultiplier;
          if (chained) bonus += FUZZY_PATH.bonusConsecutive;
          match = prev + FUZZY_PATH.charScore + bonus;
        }
      }

      // Open a gap after the best prefix, or extend the one already open.
      let gap = NEG;
      if (scoreGrid[left] > NEG / 2) gap = scoreGrid[left] + FUZZY_PATH.gapStart;
      if (gapGrid[left] > NEG / 2) gap = Math.max(gap, gapGrid[left] + FUZZY_PATH.gapExtend);
      gapGrid[cell] = gap;

      let best = scoreGrid[left];
      let src = 0;
      if (match > best) { best = match; src = 1; }
      if (gap > best) { best = gap; src = 2; }
      scoreGrid[cell] = best;
      srcGrid[cell] = src;
    }
  }

  const total = scoreGrid[m * width + n];
  if (total <= NEG / 2) return null;

  // Walk back through the winning alignment to recover highlight offsets.
  const positions = new Array(m);
  let i = m;
  let j = n;
  while (i > 0) {
    const cell = i * width + j;
    if (srcGrid[cell] === 1) {
      positions[i - 1] = j - 1;
      i--;
      j--;
    } else {
      j--;
    }
  }
  return { score: total, positions };
}

// Path-aware scoring: basename hits win outright, folder-only hits are damped.
export function scorePath(query, target, { isModified = false } = {}) {
  if (!query) return null;
  const slash = target.lastIndexOf("/");
  const base = slash === -1 ? target : target.slice(slash + 1);
  const baseStart = slash + 1;
  const sensitive = isCaseSensitive(query);
  const q = sensitive ? query : query.toLowerCase();
  const baseCmp = sensitive ? base : base.toLowerCase();
  const targetCmp = sensitive ? target : target.toLowerCase();

  let best = null;
  if (q.includes("/")) {
    best = scoreText(query, target);
  } else {
    const onBase = scoreText(query, base);
    if (onBase) {
      best = {
        score: onBase.score + FUZZY_PATH.basenameMatchBonus,
        positions: onBase.positions.map((p) => p + baseStart)
      };
    } else {
      // Folder-only hits must be contiguous: a scattering of the query across
      // `c/o/m/p/...` matches half the repo and buries the real file.
      const dir = sensitive ? target.slice(0, baseStart) : target.slice(0, baseStart).toLowerCase();
      const at = dir.indexOf(q);
      if (at === -1) return null;
      const onPath = scoreText(query, target);
      if (onPath) {
        best = {
          score: Math.round(onPath.score * FUZZY_PATH.dirOnlyPenalty),
          positions: onPath.positions
        };
      }
    }
  }
  if (!best) return null;

  if (baseCmp === q) best.score += FUZZY_PATH.exactBasenameBonus;
  else if (baseCmp.startsWith(q)) best.score += FUZZY_PATH.prefixBasenameBonus;
  else if (!q.includes("/") && targetCmp.startsWith(q)) best.score += FUZZY_PATH.prefixDirBonus;

  if (isModified) best.score += FUZZY_PATH.modifiedBonus;
  const depth = (target.match(/\//g) || []).length;
  best.score -= Math.min(depth * FUZZY_PATH.depthPenalty, FUZZY_PATH.maxDepthPenalty);
  return best;
}

// Empty query: what a coder most likely wants first — changed files, then shallow ones.
function rankDefault(index, limit) {
  const items = [
    ...index.files.map((f) => ({ path: f.path, isDir: false, isModified: !!f.isModified })),
    ...index.dirs.map((d) => ({ path: d, isDir: true, isModified: false }))
  ];
  items.sort(pickDefaultOrder);
  return items.slice(0, limit).map((it) => ({ ...it, positions: [] }));
}

function pickDefaultOrder(a, b) {
  if (a.isModified !== b.isModified) return a.isModified ? -1 : 1;
  const da = a.path.split("/").length;
  const db = b.path.split("/").length;
  if (da !== db) return da - db;
  return a.path.localeCompare(b.path);
}

// A query with a folder in it (`src/com`) completes shell-style: everything up to the
// last slash is a hard prefix, and only the next path segment is fuzzy-matched. Every
// distinct next segment is one row, so drilling into a folder never repeats it once per
// file beneath it, and typing a full filename descends to land on the file itself.
function rankInsideFolder(index, dirPart, restQuery, limit) {
  const dirPrefix = dirPart.toLowerCase();
  const rest = restQuery.toLowerCase();
  const segments = new Map();

  const offer = (segment, target, isDir, isModified) => {
    const seen = segments.get(segment);
    // A folder with the same name wins the row: it is the path the user keeps typing.
    if (seen && (seen.isDir || !isDir)) return;
    segments.set(segment, { segment, target, isDir, isModified });
  };

  for (const dir of index.dirs) {
    if (!dir.toLowerCase().startsWith(dirPrefix)) continue;
    const tail = dir.slice(dirPart.length);
    if (!tail) continue;
    const segment = tail.split("/")[0];
    offer(segment, `${dirPart}${segment}`, true, false);
  }

  for (const file of index.files) {
    if (!file.path.toLowerCase().startsWith(dirPrefix)) continue;
    const tail = file.path.slice(dirPart.length);
    if (!tail) continue;
    const slash = tail.indexOf("/");
    if (slash === -1) offer(tail, file.path, false, !!file.isModified);
    else offer(tail.slice(0, slash), `${dirPart}${tail.slice(0, slash)}`, true, false);
  }

  const hits = [];
  for (const row of segments.values()) {
    const hit = scoreText(restQuery, row.segment);
    if (!hit) continue;
    // Typing the full segment name means the user means this one.
    const exact = row.segment.toLowerCase() === rest;
    hits.push({
      path: row.target,
      isDir: row.isDir,
      isModified: row.isModified,
      score: hit.score + FUZZY_PATH.basenameMatchBonus + (exact ? FUZZY_PATH.exactBasenameBonus : 0),
      positions: hit.positions.map((p) => p + dirPart.length)
    });
  }

  if (hits.length > 0) {
    hits.sort((a, b) => b.score - a.score || Number(b.isDir) - Number(a.isDir) || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return hits.slice(0, limit);
  }
  // The folder itself is real, its children just do not match — that is an empty
  // list, not a wrong folder, so the caller must not fall back to a basename guess.
  return segments.size > 0 ? [] : null;
}

// Folder typed wrong, filename right: still find the file.
function rankByBasename(index, baseQuery, limit) {
  const scored = [];
  for (const file of index.files) {
    const hit = scorePath(baseQuery, file.path, { isModified: !!file.isModified });
    if (hit) scored.push({ path: file.path, isDir: false, isModified: !!file.isModified, ...hit });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

export function pathBase(target) {
  const slash = target.lastIndexOf("/");
  return slash === -1 ? target : target.slice(slash + 1);
}

// Rank a cached workspace index against the token typed after `@`.
export function rankPaths(index, query, limit = 10) {
  if (!index) return [];
  const q = (query || "").trim();
  if (!q) return rankDefault(index, limit);

  const slash = q.lastIndexOf("/");
  if (slash !== -1) {
    const inside = rankInsideFolder(index, q.slice(0, slash + 1), q.slice(slash + 1), limit);
    if (inside) return inside;
    // Folder typed wrong — match the filename the user actually spelled.
    const byBase = rankByBasename(index, q.slice(slash + 1), limit);
    if (byBase) return byBase;
  }

  const scored = [];
  for (const file of index.files) {
    const hit = scorePath(q, file.path, { isModified: !!file.isModified });
    if (hit) scored.push({ path: file.path, isDir: false, isModified: !!file.isModified, ...hit });
  }
  for (const dir of index.dirs) {
    const hit = scorePath(q, dir.endsWith("/") ? dir : `${dir}/`);
    if (hit) scored.push({ path: dir, isDir: true, isModified: false, ...hit });
  }

  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

// Token under the caret, not at the end of the prompt: `@` mid-sentence must complete.
const WORD_BREAK = /[\s([{"'`]/;

export function tokenAtCaret(text, caret) {
  if (typeof text !== "string") return null;
  const at = Math.max(0, Math.min(caret ?? text.length, text.length));
  let start = at;
  while (start > 0) {
    const prev = text[start - 1];
    // `\ ` keeps a path with spaces in one token, so a chosen folder stays drillable.
    if (prev === " " && text[start - 2] === "\\") { start -= 2; continue; }
    if (WORD_BREAK.test(prev)) break;
    start--;
  }
  const token = text.slice(start, at);
  if (!token) return null;
  const trigger = token[0];
  if (trigger !== "@" && trigger !== "/") return null;
  // A second `@` means this is not a mention (an email, a decorator, a URL).
  if (trigger === "@" && token.indexOf("@", 1) !== -1) return null;
  return { trigger, token, query: token.slice(1).replace(/\\ /g, " "), start, end: at };
}

// Paths that reach the agent as plain text must survive a space without splitting.
export function formatMention(path) {
  return path.replace(/ /g, "\\ ");
}
