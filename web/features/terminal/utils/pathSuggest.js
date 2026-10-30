"use client";

import { PATH_SUGGEST } from "@/features/terminal/constants/terminalConfig";
import { scoreText } from "@/shared/utils/fuzzyPath";

// Match a path-taking verb followed by a single partial arg at end of input.
// Captures [verb, partial]. Caret-after-partial is enforced by the caller.
const VERB_RE = new RegExp(`^\\s*(${PATH_SUGGEST.verbs.join("|")})\\s+(\\S*)$`, "i");

// A flag or an operator means the token is not a path argument.
const NON_PATH_PREFIX = /^[-=<>|&;]/;
// `./`, `../`, `~/`, absolute — a path the user is spelling out, no verb needed.
const EXPLICIT_PATH = /^(?:\.{1,2}\/|~\/|\/)/;

// Dir listing cache: Map<dir, { entries, expireAt }>. FIFO cap on size.
export function makeDirCache({ ttlMs, maxDirs } = PATH_SUGGEST) {
  const cache = new Map();
  const touch = (dir) => { cache.delete(dir); cache.set(dir, cache.get(dir)); };
  return {
    get(dir, now) {
      const e = cache.get(dir);
      if (!e) return null;
      if (e.expireAt < now) { cache.delete(dir); return null; }
      touch(dir);
      return e.entries;
    },
    set(dir, entries, now) {
      if (cache.size >= maxDirs && !cache.has(dir)) cache.delete(cache.keys().next().value);
      cache.set(dir, { entries, expireAt: now + ttlMs });
    },
    clear() { cache.clear(); }
  };
}

// Resolve the directory to list and the prefix to filter from raw input + cwd.
// Returns { lead, dir, prefix, partial } or null if the input isn't spelling a path.
// `lead` is everything before the path arg, so the completion keeps the whole command.
export function parsePathInput(input, cwd) {
  const m = VERB_RE.exec(input);
  let lead = "";
  let partial = "";
  if (m) {
    lead = `${m[1]} `;
    partial = m[2] || "";
  } else {
    // Any command whose last token is spelled as a path: `git add ./src`, `ls ../`.
    const lastToken = /(\S*)$/.exec(input);
    const token = lastToken ? lastToken[1] : "";
    const start = input.length - token.length;
    if (!token || !EXPLICIT_PATH.test(token) || NON_PATH_PREFIX.test(token)) return null;
    if (start > 0 && !/\s$/.test(input.slice(0, start))) return null;
    lead = input.slice(0, start);
    partial = token;
  }
  const sep = partial.lastIndexOf("/");
  if (sep < 0) return { lead, dir: cwd || "", prefix: partial, partial };
  const base = partial.slice(0, sep);
  // Absolute/home root when base is empty: "cd /" → dir "/", "cd ~/" → "~".
  if (!base) return { lead, dir: partial.startsWith("~") ? "~" : "/", prefix: partial.slice(sep + 1), partial };
  return { lead, dir: joinDir(cwd, base), prefix: partial.slice(sep + 1), partial };
}

// Resolve a possibly-relative dir against cwd. "~"/absolute pass through.
function joinDir(cwd, base) {
  if (!base) return cwd || "";
  if (base.startsWith("/") || base.startsWith("~")) return base;
  if (!cwd) return base;
  return cwd.replace(/\/+$/, "") + "/" + base;
}

// Pick matching entries for the current prefix: folder first, then best fuzzy hit.
// Returns up to maxResults matches, each annotated with the full command to insert.
export function pickMatches(entries, prefix, { partial, lead } = {}) {
  if (!entries?.length) return [];
  const base = partial && partial.includes("/")
    ? partial.slice(0, partial.lastIndexOf("/") + 1)
    : "";
  const scored = [];
  for (const entry of entries) {
    const name = entry.name + (entry.type === "folder" ? "/" : "");
    // An empty prefix lists the folder in its natural order; typing ranks by score.
    const hit = prefix ? scoreText(prefix, name) : { score: 0, positions: [] };
    if (!hit) continue;
    scored.push({ entry, name, hit });
  }
  scored.sort((a, b) => {
    const ad = a.entry.type === "folder" ? 0 : 1;
    const bd = b.entry.type === "folder" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
    return a.entry.name.localeCompare(b.entry.name);
  });
  return scored.slice(0, (PATH_SUGGEST.maxResults || 8)).map(({ entry, name, hit }) => ({
    name: entry.name,
    type: entry.type,
    arg: base + name,
    label: name,
    positions: hit.positions,
    full: `${lead || ""}${base}${name}`
  }));
}
