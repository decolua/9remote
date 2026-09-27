// Windows desktop bridge: SYSTEM worker for lock screen remote unlock and state detection.

import { spawn } from "child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { PATHS } from "./constants.js";
import { createLogger } from "./logger.js";

const logger = createLogger("desktop-bridge");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isWin = process.platform === "win32";
const RUNTIME_DIR = PATHS.BIN;
const PIPE = isWin ? "\\\\.\\pipe\\9remote-desktop" : null;
const ELEVATE_EXE = "desktop-elevate.exe";
const BRIDGE_CS = "desktop-bridge.cs";
const ELEVATE_CS = "desktop-elevate.cs";

// C# sources ship inside package: dev layout agent/lib/bin/, dist agent/dist/bin/.
const SOURCE_DIR = (() => {
  const primary = path.join(__dirname, "bin");
  if (existsSync(path.join(primary, BRIDGE_CS))) return primary;
  const fallback = path.join(__dirname, "..", "lib", "bin");
  if (existsSync(path.join(fallback, BRIDGE_CS))) return fallback;
  return primary;
})();

// Candidates for csc.exe: prefer Framework64 v4, fall back to 32-bit and v3.5.
function findCsc() {
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework64", "v3.5", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v3.5", "csc.exe"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function isSupported() { return isWin; }

const ENABLED_FLAG = path.join(PATHS.ROOT, "unlock.enabled");
export function isEnabled() { return existsSync(ENABLED_FLAG); }
function setEnabled(v) {
  try {
    if (v) writeFileSync(ENABLED_FLAG, "1");
    else unlinkSync(ENABLED_FLAG);
  } catch (e) { logger.warn(`setEnabled(${v}) failed: ${e.message}`); }
}

function sourceVersion() {
  try { return _parseVersion(readFileSync(path.join(SOURCE_DIR, BRIDGE_CS), "utf8")); }
  catch { return null; }
}

function bridgeExePath() {
  const v = sourceVersion();
  return v ? path.join(RUNTIME_DIR, _exeNameFor(v)) : null;
}

export function isBuilt() {
  const bridge = bridgeExePath();
  return !!bridge && existsSync(bridge) && existsSync(path.join(RUNTIME_DIR, ELEVATE_EXE));
}

async function probeWorkerVersion() {
  if (!isWin) return { version: null, reachable: false };
  try {
    const r = await pipeCmd("VERSION", 1500);
    const m = /^VERSION\s+(\S+)/.exec(r.trim());
    return { version: m ? m[1] : null, reachable: true };
  } catch { return { version: null, reachable: false }; }
}

async function checkStale() {
  const { version, reachable } = await probeWorkerVersion();
  return _isWorkerStale({ workerVersion: version, sourceVersion: sourceVersion(), reachable });
}

// Prune superseded desktop-bridge-<n>.exe binaries.
function pruneOldExes(keepName) {
  try {
    for (const f of readdirSync(RUNTIME_DIR)) {
      const obsolete = /^desktop-bridge-(\d+)\.exe$/.test(f) || f === "desktop-bridge.exe";
      if (!obsolete || f === keepName) continue;
      try { unlinkSync(path.join(RUNTIME_DIR, f)); } catch {}
    }
  } catch {}
}

// Stop running worker via pipe and wait until it exits.
async function stopWorker() {
  try { await pipeCmd("STOP", 2000); } catch {}
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    try { await pipeCmd("STATE", 600); } catch { return true; }
  }
  return false;
}

function runHidden(cmd, args) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("exit", (code) => resolve({ ok: code === 0, err: err.trim() }));
      p.on("error", (e) => { logger.error(`spawn failed: ${cmd}: ${e.message}`); resolve({ ok: false, err: e.message }); });
    } catch (e) { logger.error(`spawn throw: ${e.message}`); resolve({ ok: false, err: e.message }); }
  });
}

// Copy C# sources to runtime dir and compile via csc.
async function buildBinaries() {
  if (!isWin) return false;
  const version = sourceVersion();
  if (!version) { logger.error("build: cannot read VERSION from worker source"); return false; }
  const csc = findCsc();
  if (!csc) { logger.warn("csc.exe not found — .NET Framework 4 missing"); return false; }
  mkdirSync(RUNTIME_DIR, { recursive: true });

  const targets = [[BRIDGE_CS, _exeNameFor(version)], [ELEVATE_CS, ELEVATE_EXE]];
  for (const [cs, exe] of targets) {
    const srcCs = path.join(SOURCE_DIR, cs);
    const rtCs = path.join(RUNTIME_DIR, cs);
    const rtExe = path.join(RUNTIME_DIR, exe);
    if (!existsSync(srcCs)) { logger.warn(`source missing: ${cs}`); return false; }
    if (exe !== ELEVATE_EXE && existsSync(rtExe)) continue;
    copyFileSync(srcCs, rtCs);
    const r = await runHidden(csc, ["-nologo", "-target:winexe", `-out:${rtExe}`, rtCs]);
    if (!r.ok) { logger.error(`csc build failed for ${cs}: ${r.err}`); return false; }
  }
  pruneOldExes(_exeNameFor(version));
  return true;
}

function diagnoseWorkerProcess() {
  try {
    const p = spawn("cmd.exe",
      ["/c", `tasklist /FI "IMAGENAME eq desktop-bridge*" /FO CSV /NH`],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("exit", () => {
      const found = out.trim() && !/No tasks/i.test(out);
      logger.warn(`worker not reachable via pipe; process ${found ? "RUNNING" : "NOT RUNNING"}`);
    });
    p.on("error", () => {});
  } catch {}
}

export function _escapePs(s) { return String(s).replace(/'/g, "''"); }

export const TASK_NAME = "9remoteDesktopUnlock";

// Register and start AtStartup SYSTEM task launching desktop-elevate.exe.
export function _buildInstallTaskCmd(launcherPath, taskName) {
  const inner = [
    `$a = New-ScheduledTaskAction -Execute '${_escapePs(launcherPath)}'`,
    `$t = New-ScheduledTaskTrigger -AtStartup`,
    `$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest`,
    `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `Register-ScheduledTask -TaskName '${_escapePs(taskName)}' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${_escapePs(taskName)}'`
  ].join("; ");
  return `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','${_escapePs(inner)}' -Wait`;
}

export function _buildDeleteTaskCmd(taskName) {
  const inner = `Unregister-ScheduledTask -TaskName '${_escapePs(taskName)}' -Confirm:$false -ErrorAction SilentlyContinue; exit 0`;
  return `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','${_escapePs(inner)}' -Wait`;
}

export function _shouldElevate({ alive, hasTask }) { return !alive || !hasTask; }

export function _parseVersion(src) {
  if (!src) return null;
  const m = /const\s+string\s+VERSION\s*=\s*"([^"]+)"/.exec(src);
  return m ? m[1] : null;
}

export function _exeNameFor(version) { return `desktop-bridge-${version}.exe`; }

// Pick highest version desktop-bridge-<n>.exe from directory listing.
export function _pickNewestExe(files) {
  let best = null, bestV = -1;
  for (const f of files || []) {
    const m = /^desktop-bridge-(\d+)\.exe$/.exec(f);
    if (!m) continue;
    const v = parseInt(m[1], 10);
    if (v > bestV) { bestV = v; best = f; }
  }
  return best;
}

// Check if running worker version is older than shipped source version.
export function _isWorkerStale({ workerVersion, sourceVersion, reachable = true }) {
  if (!sourceVersion) return false;
  if (!reachable) return false;
  if (!workerVersion) return true;
  return parseInt(workerVersion, 10) < parseInt(sourceVersion, 10);
}

function runPs(ps, label) {
  return new Promise((resolve) => {
    try {
      const p = spawn("powershell.exe",
        ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
        { windowsHide: true, stdio: "ignore" });
      p.on("exit", (code) => { if (code !== 0) logger.warn(`${label}: powershell exit=${code}`); resolve(code === 0); });
      p.on("error", (e) => { logger.error(`${label}: spawn error: ${e.message}`); resolve(false); });
    } catch (e) { logger.error(`${label}: throw: ${e.message}`); resolve(false); }
  });
}

function hasBootTask() {
  return new Promise((resolve) => {
    try {
      const p = spawn("schtasks.exe", ["/query", "/TN", TASK_NAME],
        { windowsHide: true, stdio: "ignore" });
      p.on("exit", (code) => resolve(code === 0));
      p.on("error", () => resolve(false));
    } catch { resolve(false); }
  });
}

function installBootTask() {
  const launcher = path.join(RUNTIME_DIR, ELEVATE_EXE);
  if (!existsSync(launcher)) { logger.error("installBootTask: launcher exe missing"); return Promise.resolve(false); }
  return runPs(_buildInstallTaskCmd(launcher, TASK_NAME), "installBootTask");
}

export async function uninstall() {
  if (!isWin) return { ok: false, reason: "unsupported" };
  setEnabled(false);
  try { await pipeCmd("STOP", 2000); }
  catch (e) { logger.warn(`uninstall: pipe STOP failed (${e.message})`); }
  await runPs(_buildDeleteTaskCmd(TASK_NAME), "deleteBootTask");
  await sleep(500);
  const stillAlive = await isAlive();
  return { ok: !stillAlive, reason: stillAlive ? "worker_alive" : "stopped" };
}

function pipeCmd(cmd, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const c = net.connect(PIPE);
    let buf = "";
    const finish = (err, val) => { clearTimeout(t); c.destroy(); err ? reject(err) : resolve(val); };
    const ondata = (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i >= 0) { c.off("data", ondata); finish(null, buf.slice(0, i).trim()); }
    };
    const t = setTimeout(() => finish(new Error("pipe timeout")), timeoutMs);
    c.on("connect", () => { c.on("data", ondata); try { c.write(cmd + "\n"); } catch (e) { finish(e); } });
    c.on("error", (e) => finish(e));
  });
}

let _running = false;

export async function isAlive() {
  if (!isWin) return false;
  try {
    await pipeCmd("STATE", 1500);
    _running = true;
    return true;
  } catch {
    _running = false;
    return false;
  }
}

export function isRunningCached() { return _running; }

// Enable desktop unlock: build binaries, register AtStartup task, and start worker.
export async function install() {
  if (!isWin) return { ok: false, reason: "unsupported" };
  setEnabled(true);

  let alive = await isAlive();
  const hasTask = await hasBootTask();
  const stale = await checkStale();

  if (!isBuilt() && !await buildBinaries()) {
    logger.error("install: build failed");
    return { ok: false, reason: "build_failed" };
  }

  if (stale && alive) {
    if (!await stopWorker()) {
      logger.warn("install: stale worker did not stop");
      return { ok: false, reason: "stop_failed" };
    }
    _running = false;
    alive = false;
  }

  if (!_shouldElevate({ alive, hasTask })) return { ok: true, reason: "already_running" };

  if (!await installBootTask()) {
    logger.warn("install: task registration failed (UAC denied?)");
    return { ok: false, reason: "elevate_failed" };
  }

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await isAlive()) return { ok: true, reason: stale ? "updated" : "started" };
  }
  logger.error("install: worker did not come up in time");
  diagnoseWorkerProcess();
  return { ok: false, reason: "worker_timeout" };
}

export async function getStatus() {
  return {
    supported: isWin,
    built: isBuilt(),
    enabled: isEnabled(),
    running: await isAlive(),
    stale: await checkStale(),
  };
}

export async function getDesktopState() {
  if (!isWin) return null;
  try {
    const r = await pipeCmd("STATE");
    _running = true;
    return r.replace(/^DESKTOP\s*/, "").trim();
  } catch { _running = false; return null; }
}

export async function typeText(text) {
  if (!isWin) return { ok: false, reason: "unsupported" };
  if (typeof text !== "string" || !text) return { ok: false, reason: "empty" };
  // Pipe protocol is line-based; reject newlines to prevent truncation.
  if (/[\r\n]/.test(text)) return { ok: false, reason: "newline_forbidden" };
  try {
    const r = await pipeCmd("TYPE " + text, 15000);
    _running = true;
    return { ok: r === "OK" };
  } catch (e) { _running = false; return { ok: false, reason: e.message }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
