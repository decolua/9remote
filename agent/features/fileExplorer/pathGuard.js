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

// Check if absolute path is inside any sensitive location
export function isSensitivePath(input) {
  const abs = canonicalize(input);
  if (!abs) return false;
  for (const sys of SENSITIVE_ABS_PATHS) {
    if (abs === sys || abs.startsWith(sys + path.sep)) return true;
  }
  for (const rel of SENSITIVE_HOME_DIRS) {
    const sensitive = path.join(HOME, rel);
    if (abs === sensitive || abs.startsWith(sensitive + path.sep)) return true;
  }
  return false;
}
