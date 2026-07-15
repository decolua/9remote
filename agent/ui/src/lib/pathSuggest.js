// Ported from web/features/terminal/utils/pathSuggest.js (mirror impl).

import { PATH_SUGGEST } from "./constants";

// Match a path-taking verb followed by a single partial arg at end of input.
const VERB_RE = new RegExp(`^\\s*(${PATH_SUGGEST.verbs.join("|")})\\s+(\\S*)$`, "i");

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
// Returns { verb, dir, prefix, partial } or null if input isn't a path-arg verb form.
export function parsePathInput(input, cwd) {
  const m = VERB_RE.exec(input);
  if (!m) return null;
  const verb = m[1];
  const partial = m[2] || "";
  const sep = partial.lastIndexOf("/");
  if (sep < 0) return { verb, dir: cwd || "", prefix: partial, partial };
  const base = partial.slice(0, sep);
  // Absolute/home root when base is empty: "cd /" → dir "/", "cd ~/" → "~".
  if (!base) return { verb, dir: partial.startsWith("~") ? "~" : "/", prefix: partial.slice(sep + 1), partial };
  return { verb, dir: joinDir(cwd, base), prefix: partial.slice(sep + 1), partial };
}

// Resolve a possibly-relative dir against cwd. "~"/absolute pass through.
function joinDir(cwd, base) {
  if (!base) return cwd || "";
  if (base.startsWith("/") || base.startsWith("~")) return base;
  if (!cwd) return base;
  return cwd.replace(/\/+$/, "") + "/" + base;
}

// Pick matching entries for the current prefix: folders first, then alphabetical.
// Returns up to maxResults matches, each annotated with the full arg to insert.
export function pickMatches(entries, prefix, { partial, verb } = {}) {
  if (!entries?.length) return [];
  const norm = prefix.toLowerCase();
  const base = partial && partial.includes("/")
    ? partial.slice(0, partial.lastIndexOf("/") + 1)
    : "";
  const matches = entries
    .filter((e) => e.name.toLowerCase().startsWith(norm))
    .map((e) => ({
      name: e.name,
      type: e.type,
      arg: base + e.name + (e.type === "folder" ? "/" : ""),
      label: e.name + (e.type === "folder" ? "/" : ""),
      full: `${verb} ${base}${e.name}${e.type === "folder" ? "/" : ""}`,
    }))
    .sort((a, b) => {
      const ad = a.type === "folder" ? 0 : 1;
      const bd = b.type === "folder" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
  return matches.slice(0, (PATH_SUGGEST.maxResults || 8));
}
