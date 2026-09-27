// Logcat streaming — one tail per socket, filtered agent-side.
// Filtering here (not in the browser) is the point: an unfiltered logcat is
// megabytes a minute and would swamp the transport.

import { findAdb } from "./adb.js";
import { spawn, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { LOGCAT, LOGCAT_NOISE_TAGS, LOGCAT_DEFAULT_LEVEL } from "./constants.js";

const LEVELS = ["V", "D", "I", "W", "E", "F"];

/**
 * A live logcat tail. Lines are batched so a burst becomes one message rather
 * than hundreds, and the batch is capped so a log storm can't grow unbounded.
 */
export class LogcatStream {
  /**
   * @param {string} serial
   * @param {object} opts - { packageName, minLevel, search }
   * @param {(lines: string[]) => void} onLines
   */
  constructor(serial, opts, onLines) {
    this.serial = serial;
    this.onLines = onLines;
    this.closed = false;
    this._proc = null;
    this._pending = [];
    this._timer = null;
    this._partial = "";
    this.setFilter(opts);
  }

  /** Filters apply to lines as they arrive — changing them needs no restart. */
  setFilter({ packageName, minLevel, search, includeNoise } = {}) {
    this.includeNoise = !!includeNoise;
    this.packageName = typeof packageName === "string" && packageName ? packageName : null;
    this.minLevel = LEVELS.includes(minLevel) ? minLevel : LOGCAT_DEFAULT_LEVEL;
    this.search = typeof search === "string" && search ? search.toLowerCase() : null;
    // The pid set is resolved once per start; a restarted app changes pid, so
    // it is refreshed whenever the package filter is set.
    // Resolved in the background: a sync pidof froze the agent for ~180ms every
    // time a filter changed. Until it lands, no pid filter is applied.
    this._pids = null;
    if (this.packageName) {
      const wanted = this.packageName;
      pidsOf(this.serial, wanted).then((pids) => {
        if (this.packageName === wanted) this._pids = pids;
      });
    }
  }

  start() {
    const bin = findAdb();
    if (!bin) throw new Error("adb not found");
    // -T gives a short backlog so an opened panel is not blank; threadtime
    // carries pid and level, which the filters below need.
    this._proc = spawn(bin, ["-s", this.serial, "logcat", "-v", "threadtime", "-T", String(LOGCAT.backlogLines)], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    this._proc.stdout.on("data", (buf) => this._onData(buf));
    this._proc.on("exit", () => { if (!this.closed) this.close(); });
    return this;
  }

  _onData(buf) {
    // Chunks split mid-line; carry the remainder to the next chunk.
    const text = this._partial + buf.toString("utf8");
    const lines = text.split("\n");
    this._partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!this._matches(line)) continue;
      this._pending.push(line.slice(0, LOGCAT.maxLineLength));
      if (this._pending.length >= LOGCAT.maxBatchLines) { this._flush(); return; }
    }
    if (this._pending.length && !this._timer) {
      this._timer = setTimeout(() => this._flush(), LOGCAT.batchMs);
    }
  }

  // threadtime: "MM-DD HH:MM:SS.mmm  PID  TID L TAG: message"
  _matches(line) {
    const m = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+\d+\s+([VDIWEF])\s+([^:]*):/.exec(line);
    // Per-frame vendor noise drowns the real output — see LOGCAT_NOISE_TAGS.
    if (!this.includeNoise && m && LOGCAT_NOISE_TAGS.includes(m[3].trim())) return false;
    if (m) {
      if (LEVELS.indexOf(m[2]) < LEVELS.indexOf(this.minLevel)) return false;
      if (this._pids && !this._pids.has(Number(m[1]))) return false;
    } else if (this._pids || this.minLevel !== "V") {
      // Unparseable (a separator like "--------- beginning of main") — drop it
      // whenever a filter is active, so the panel shows only what was asked for.
      return false;
    }
    return !this.search || line.toLowerCase().includes(this.search);
  }

  _flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._pending.length || this.closed) return;
    const lines = this._pending;
    this._pending = [];
    this.onLines(lines);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._timer);
    this._timer = null;
    this._pending = [];
    try { this._proc?.kill("SIGKILL"); } catch { /* already gone */ }
    this._proc = null;
  }
}

// A package can run several processes (:remote services), so match them all.
async function pidsOf(serial, packageName) {
  const bin = findAdb();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, ["-s", serial, "shell", "pidof", packageName], { timeout: 5000 });
    const pids = stdout.trim().split(/\s+/).map(Number).filter(Number.isInteger);
    // Empty set would filter everything out; null means "no pid filter yet".
    return pids.length ? new Set(pids) : null;
  } catch { return null; }
}
