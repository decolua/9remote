import fs from "fs";
import path from "path";
import os from "os";
import { SENSITIVE_HOME_DIRS, SENSITIVE_ABS_PATHS } from "./constants.js";

const HOME = os.homedir();

// Resolve ~ + symlinks, return canonical absolute path (null if not exists)
function canonicalize(p) {
  if (!p) return null;
  const resolved = p.startsWith("~") ? p.replace(/^~/, HOME) : p;
  try { return fs.realpathSync(resolved); } catch { return path.resolve(resolved); }
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
