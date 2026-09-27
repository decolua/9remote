// Atomic JSON file helpers.
//
// The agent runs as two processes (CLI + spawned server) that share files under
// ~/.9remote. writeFileSync truncates and then fills, so a reader in the other
// process can observe a half-written file — measured at ~5% of reads under
// concurrent load. rename(2) is atomic within a filesystem, so writing to a
// temp file and renaming it over the target means a reader always sees either
// the whole previous version or the whole new one.
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

// Monotonic per-process counter. Date.now() alone is NOT enough: hundreds of
// writes land in the same millisecond, so two concurrent writes in this process
// would share a temp path and one could rename the other's partial file.
let tmpSeq = 0;

/**
 * Write JSON so concurrent readers never observe a partial file.
 * @param {string} file target path
 * @param {any} data JSON-serialisable value
 * @param {{mode?: number, spaces?: number}} [opts]
 */
export function writeJsonAtomic(file, data, opts = {}) {
  const { mode = 0o600, spaces = 2 } = opts;
  mkdirSync(dirname(file), { recursive: true });
  // Unique per process AND per call — see tmpSeq above.
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, spaces), { mode });
    renameSync(tmp, file);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Read JSON, returning fallback on a missing/corrupt file. Atomic writes make
 * corruption unlikely, but a file written by an older build may still be torn.
 */
export function readJsonSafe(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
