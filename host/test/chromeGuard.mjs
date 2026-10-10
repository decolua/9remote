// Import FIRST in any test that launches Chrome. Isolates the profiles dir and
// guarantees no Chrome outlives the run: exit/signal sweep, plus a stale-run
// sweep for runs that died uncatchably (SIGKILL, power loss).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "9remote-test-";

// Chrome is reparented to init when its owner dies, so it is killed by profile dir.
function sweep(dir) {
  try { execFileSync("pkill", ["-9", "-f", "--", dir]); } catch { /* exit 1 = nothing to kill */ }
  // Chrome flushes files while dying — retry past ENOTEMPTY
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* best effort */ }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

// Dir name carries the owner pid: a dead owner = abandoned run (PID reuse errs on the safe side).
for (const name of fs.readdirSync(os.tmpdir())) {
  const m = new RegExp(`^${PREFIX}(\\d+)-`).exec(name);
  if (m && !alive(Number(m[1]))) sweep(path.join(os.tmpdir(), name));
}

export const TEST_PROFILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${process.pid}-`));
process.env.NREMOTE_BROWSER_PROFILES_DIR = TEST_PROFILES_DIR;
process.on("exit", () => sweep(TEST_PROFILES_DIR));
// SIGKILL runs no handler at all: a detached watcher outlives us and sweeps the moment we die.
// The dir rides in env, not argv — pkill -f on the dir path must not match the watcher itself.
spawn("sh", ["-c", 'while kill -0 "$W_PID" 2>/dev/null; do sleep 1; done; pkill -9 -f -- "$W_DIR"; sleep 1; rm -rf "$W_DIR"'], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env, W_PID: String(process.pid), W_DIR: TEST_PROFILES_DIR }
}).unref();
// Signals skip "exit" handlers unless routed through process.exit
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));
