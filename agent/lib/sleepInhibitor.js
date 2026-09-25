// Block system sleep + display sleep — keeps agent reachable and screen capturable.
// Mode-based: "never" = block the whole time; "30m/1h/..." = auto-off after N idle
// (no active connections); "none" = do not block sleep at all.
import { spawn, execSync } from "child_process";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import { createLogger } from "./logger.js";

const logger = createLogger("sleep");

const PLATFORM_CMD = {
  darwin: { cmd: "caffeinate", args: ["-imsd", "-w", String(process.pid)] },
  linux:  { cmd: "systemd-inhibit", args: ["--what=idle:sleep:handle-lid-switch", "--who=9remote", "--why=remote-active", "sleep", "infinity"] },
  win32:  {
    cmd: "powershell.exe",
    // PowerCreateRequest/SetRequest: SystemRequired(1) blocks sleep, ExecutionRequired(3) survives Modern Standby, DisplayRequired(0) blocks display off + auto-lock (MS doc) — remote capture needs display on.
    args: ["-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
      "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;namespace W3{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct RC{public uint Version;public uint Flags;public string Simple;}public class K{[DllImport(\"kernel32\")]public static extern IntPtr PowerCreateRequest(ref RC c);[DllImport(\"kernel32\")]public static extern bool PowerSetRequest(IntPtr h,uint t);}}'; $c=New-Object W3.RC; $c.Version=0; $c.Flags=1; $c.Simple='9remote'; $h=[W3.K]::PowerCreateRequest([ref]$c); if($h -eq [IntPtr]::Zero){[Console]::Error.WriteLine('PowerCreateRequest failed')} else { [W3.K]::PowerSetRequest($h,1) | Out-Null; [W3.K]::PowerSetRequest($h,3) | Out-Null; [W3.K]::PowerSetRequest($h,0) | Out-Null; while($true){Start-Sleep 3600} }"]
  }
};

let proc = null;
let mode = REMOTE_CONFIG.sleepInhibit?.defaultMode || "never";
let idleTimer = null;
let connectionCount = 0;

let exitHookRegistered = false;
function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on("exit", () => { if (proc) { try { proc.kill(); } catch {} proc = null; } });
}

// Kill leaked caffeinate from crashed older versions (orphaned → reparented to launchd)
let orphansReaped = false;
function reapOrphans() {
  if (orphansReaped) return;
  orphansReaped = true;
  if (process.platform !== "darwin") return;
  try {
    const out = execSync("pgrep -f 'caffeinate -imsd'", { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) {
      const ppid = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8" }).trim();
      if (ppid === "1") { try { process.kill(Number(pid)); } catch {} } // ppid=1 → orphan
    }
  } catch {}
}

function spawnProc() {
  if (proc) return;
  const c = PLATFORM_CMD[process.platform];
  if (!c) return;
  try {
    proc = spawn(c.cmd, c.args, { stdio: "ignore", windowsHide: true });
    proc.on("error", (err) => { logger.warn(`inhibitor error: ${err.message}`); proc = null; });
    proc.on("exit", () => { proc = null; });
    registerExitHook();
  } catch (err) {
    logger.warn(`Failed to start sleep inhibitor: ${err.message}`);
    proc = null;
  }
}

function killProc() {
  if (!proc) return;
  try { proc.kill(); } catch {}
  proc = null;
}

function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function getModeMs(m) {
  const presets = REMOTE_CONFIG.sleepInhibit?.presets || {};
  return presets[m] ?? null;
}

function isValidMode(m) {
  const presets = REMOTE_CONFIG.sleepInhibit?.presets || {};
  return Object.prototype.hasOwnProperty.call(presets, m);
}

// Core reconciler — decides whether to run proc + arm idle timer based on mode + connections
function reconcile() {
  reapOrphans();
  clearIdleTimer();
  // "none" = user does not want sleep blocked at all
  if (mode === "none") {
    killProc();
    return;
  }
  if (mode === "never") {
    spawnProc();
    return;
  }
  const ms = getModeMs(mode);
  if (ms == null) {
    // unknown mode — fallback to never
    spawnProc();
    return;
  }
  // Active connection → keep on
  if (connectionCount > 0) {
    spawnProc();
    return;
  }
  // Idle → arm timer; until it fires, keep current state. Default: keep ON during idle window.
  spawnProc();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (connectionCount === 0) killProc();
  }, ms);
}

export function start() {
  reconcile();
}

export function stop() {
  clearIdleTimer();
  killProc();
}

export function isActive() {
  return proc !== null;
}

export function getMode() {
  return mode;
}

export function setMode(next) {
  if (!isValidMode(next)) return mode;
  mode = next;
  reconcile();
  return mode;
}

// Called by connection tracker on every connect/disconnect
export function onConnectionChange(count) {
  connectionCount = count;
  reconcile();
}
