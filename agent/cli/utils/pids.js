/**
 * Centralized PID management for 9remote long-lived processes.
 *
 * We track ONLY two PIDs — the minimum needed to safely release file locks
 * during `npm i -g 9remote@latest` without killing unrelated apps on the
 * machine:
 *
 *   - agent        → the CLI that holds dist/cli.cjs open. Its children
 *                    (server node.exe + tray helper binary) die automatically
 *                    when we kill the agent tree (`taskkill /F /T`).
 *   - cloudflared  → spawned as a child of agent too, but tracked separately
 *                    because it may become orphan if agent crashes, and
 *                    because `killCloudflared()` is called at runtime for
 *                    network-change restarts.
 *
 * PID files live in ~/.9remote/pids/<name>.pid. Update scripts kill by PID
 * only — never by image name (taskkill /IM) or commandline match, since
 * those would also terminate unrelated node.exe / cloudflared.exe processes.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

const PIDS_DIR = path.join(os.homedir(), ".9remote", "pids");

function ensureDir() {
  try {
    if (!fs.existsSync(PIDS_DIR)) fs.mkdirSync(PIDS_DIR, { recursive: true });
  } catch {}
}

function pidPath(name) {
  return path.join(PIDS_DIR, `${name}.pid`);
}

/** Write PID to ~/.9remote/pids/<name>.pid. Silent fail. */
export function writePid(name, pid) {
  if (!pid) return;
  try {
    ensureDir();
    fs.writeFileSync(pidPath(name), String(pid));
  } catch {}
}

/** Read PID from file, or null if missing/invalid. */
export function readPid(name) {
  try {
    const raw = fs.readFileSync(pidPath(name), "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Remove PID file. Silent fail. */
export function clearPid(name) {
  try {
    fs.unlinkSync(pidPath(name));
  } catch {}
}

/** Check if a PID is still alive (does not kill). */
export function isAlive(pid) {
  if (!pid) return false;
  try {
    // Signal 0 = existence check on all platforms
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill one tracked process by name. Uses SIGKILL on POSIX, `taskkill /F /PID`
 * on Windows. Clears the PID file regardless of outcome.
 * Returns true if a kill was attempted, false if no PID on record.
 */
export function killByName(name) {
  const pid = readPid(name);
  clearPid(name);
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      // taskkill /T also terminates the entire child tree (needed for systray
      // helper which spawns its own child, and for detached background agent).
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {}
  return true;
}

/** Names of every tracked PID. Shared with update shell scripts.
 *  NOTE: ptyDaemon is intentionally excluded — we never kill it to keep
 *  terminal sessions alive across agent restarts / updates. */
export const TRACKED_NAMES = ["cloudflared", "agent"];

/** Kill every tracked 9remote process. Safe to call repeatedly. */
export function killAll() {
  // Cloudflared first so it can't reconnect mid-shutdown; agent's `/F /T`
  // then sweeps server + tray (direct children).
  for (const name of TRACKED_NAMES) {
    killByName(name);
  }
}

/** Absolute path to the PIDs directory (for shell scripts). */
export function getPidsDir() {
  return PIDS_DIR;
}
