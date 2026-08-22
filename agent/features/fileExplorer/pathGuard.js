import fs from "fs";
import path from "path";
import os from "os";
import { SENSITIVE_HOME_DIRS, SENSITIVE_ABS_PATHS } from "./constants.js";

const HOME = os.homedir();

// Resolve ~ + symlinks, return canonical absolute path. Walks up to the nearest
// existing ancestor, resolves its realpath (which follows symlinks), then re-appends
// the non-existent tail. Avoids the lexical `path.resolve` fallback that let a
// symlinked path escape detection when its target file did not yet exist.
function canonicalize(p) {
  if (!p) return null;
  const resolved = p.startsWith("~") ? p.replace(/^~/, HOME) : p;
  const abs = path.resolve(resolved);
  try {
    return fs.realpathSync(abs);
  } catch {
    let head = abs, tail = [];
    while (!fs.existsSync(head)) {
      tail.unshift(path.basename(head));
      const parent = path.dirname(head);
      if (parent === head) return abs; // hit fs root without resolving
      head = parent;
    }
    try { return path.join(fs.realpathSync(head), ...tail); } catch { return abs; }
  }
}

// macOS/Windows filesystems are case-insensitive but realpath keeps the caller's
// casing, so ~/.SSH would read the same file while dodging a case-sensitive compare.
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
const fold = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);

// Blocklist entries go through canonicalize too — on macOS /etc/ssh realpaths to
// /private/etc/ssh, which a literal compare would never match.
const CANONICAL_ABS_PATHS = SENSITIVE_ABS_PATHS.flatMap((p) => {
  const real = canonicalize(p);
  return real && real !== p ? [p, real] : [p];
});

function isUnder(abs, target) {
  const a = fold(abs), t = fold(target);
  return a === t || a.startsWith(t + path.sep);
}

// Check if absolute path is inside any sensitive location
export function isSensitivePath(input) {
  const abs = canonicalize(input);
  if (!abs) return false;
  for (const sys of CANONICAL_ABS_PATHS) {
    if (isUnder(abs, sys)) return true;
  }
  for (const rel of SENSITIVE_HOME_DIRS) {
    if (isUnder(abs, path.join(HOME, rel))) return true;
  }
  return false;
}
