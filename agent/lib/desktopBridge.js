// Windows desktop bridge orchestrator — builds the worker/launcher, spawns the
// SYSTEM worker via UAC elevation, and exposes a tiny pipe client for desktop
// state detection + text typing (used to unlock the login screen remotely).
//
// Mirrors the ptyDaemon runtime pattern: .cs sources ship inside the package,
// .exe artifacts live in ~/.9remote/bin/ (PATHS.BIN) so they never lock files
// in node_modules/9remote and survive `npm i -g 9remote@latest` (autoupdate).
// The worker runs as Local System, independent of the agent process — autoupdate
// only kills cloudflared + agent PIDs, never this worker.

import { spawn } from "child_process";
import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync, unlinkSync } from "fs";
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
const BRIDGE_EXE = "desktop-bridge.exe";
const ELEVATE_EXE = "desktop-elevate.exe";
const BRIDGE_CS = "desktop-bridge.cs";
const ELEVATE_CS = "desktop-elevate.cs";
// Per-user scheduled task that re-spawns the launcher at every logon (console
// session, /RL HIGHEST) so the worker survives reboots without a UAC prompt.
// /RU user (not SYSTEM) keeps the worker in the console session — SYSTEM tasks
// run in session 0 and SendInput misses the user's Winlogon desktop.
const TASK_NAME = "9remote-unlock";

// .cs sources ship inside the package: dev layout agent/lib/bin/, dist agent/dist/bin/.
const SOURCE_DIR = (() => {
  const primary = path.join(__dirname, "bin");
  if (existsSync(path.join(primary, BRIDGE_CS))) return primary;
  const fallback = path.join(__dirname, "..", "lib", "bin");
  if (existsSync(path.join(fallback, BRIDGE_CS))) return fallback;
  return primary;
})();

// csc.exe candidates — prefer Framework64 v4 (C# 5), fall back to 32-bit + v3.5
// (C# 3) so the build works on machines with only older .NET installed. Our C#
// deliberately avoids C# 4+ features (no `dynamic`, no `async`, no `$""`, no `=>`
// members) so it compiles on every candidate here.
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

// Persisted "user toggled On" flag. The agent reads it at startup and re-spawns
// the worker if it's gone (reboot killed the ad-hoc worker). This gives boot
// persistence without a SYSTEM scheduled task (which ran the worker in session 0).
const ENABLED_FLAG = path.join(PATHS.ROOT, "unlock.enabled");
export function isEnabled() { return existsSync(ENABLED_FLAG); }
function setEnabled(v) {
  try {
    if (v) writeFileSync(ENABLED_FLAG, "1");
    else unlinkSync(ENABLED_FLAG);
  } catch (e) { logger.warn(`setEnabled(${v}) failed: ${e.message}`); }
}

export function isBuilt() {
  return existsSync(path.join(RUNTIME_DIR, BRIDGE_EXE)) && existsSync(path.join(RUNTIME_DIR, ELEVATE_EXE));
}

// True if any shipped .cs source is newer than its runtime .exe → rebuild needed.
function sourcesNewer() {
  for (const [cs, exe] of [[BRIDGE_CS, BRIDGE_EXE], [ELEVATE_CS, ELEVATE_EXE]]) {
    const srcCs = path.join(SOURCE_DIR, cs);
    const rtExe = path.join(RUNTIME_DIR, exe);
    if (!existsSync(rtExe)) return true;
    try {
      if (existsSync(srcCs) && statSync(srcCs).mtimeMs > statSync(rtExe).mtimeMs) return true;
    } catch {}
  }
  return false;
}

// Ask the running worker to exit gracefully (frees the locked .exe for rebuild).
async function stopWorker() {
  try { await pipeCmd("STOP", 2000); } catch {}
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    try { await pipeCmd("STATE", 600); return false; } catch { return true; }
  }
  return true;
}

// Spawn a process hidden, capturing stderr so compile errors surface.
// Async (event-loop friendly) — replaces execSync which blocked the server
// during compile and caused the UI to lose CSS on first load.
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

// Copy .cs → runtime dir + compile both to .exe via csc. Idempotent: skips if exe
// already newer than the source. Returns true on success.
async function buildBinaries() {
  if (!isWin) return false;
  const csc = findCsc();
  if (!csc) { logger.warn("csc.exe not found — .NET Framework 4 missing"); return false; }
  mkdirSync(RUNTIME_DIR, { recursive: true });

  const newer = (a, b) => {
    try { return existsSync(a) && existsSync(b) && statSyncMs(a) >= statSyncMs(b); } catch { return false; }
  };
  for (const [cs, exe] of [[BRIDGE_CS, BRIDGE_EXE], [ELEVATE_CS, ELEVATE_EXE]]) {
    const srcCs = path.join(SOURCE_DIR, cs);
    const rtCs = path.join(RUNTIME_DIR, cs);
    const rtExe = path.join(RUNTIME_DIR, exe);
    if (!existsSync(srcCs)) { logger.warn(`source missing: ${cs}`); return false; }
    copyFileSync(srcCs, rtCs);
    if (newer(rtExe, rtCs)) continue;
    const r = await runHidden(csc, ["-nologo", "-target:winexe", `-out:${rtExe}`, rtCs]);
    if (!r.ok) { logger.error(`csc build failed for ${cs}: ${r.err}`); return false; }
  }
  return true;
}

function statSyncMs(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

// Best-effort: is the worker process alive even though the pipe is dead?
// Distinguishes "task never started" from "worker spawned then crashed".
function diagnoseWorkerProcess() {
  try {
    const p = spawn("cmd.exe",
      ["/c", `tasklist /FI "IMAGENAME eq desktop-bridge.exe" /FO CSV /NH`],
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

// --- PowerShell helpers (exported as _* for unit testing) ---
// Escape a string for safe embedding inside a PowerShell single-quoted string.
export function _escapePs(s) { return String(s).replace(/'/g, "''"); }

// Build the UAC wrapper command that registers + runs the per-user logon task.
// Inline PowerShell (no .ps1) — kept short and try/catch-free to avoid the
// quoting hell that broke -Command earlier. Register-ScheduledTask handles the
// launcher path natively (no /TR quoting).
export function _buildElevateCmd(launcherPath, taskName) {
  // Inner uses the raw values; the whole inner string is single-quote-escaped
  // once when embedded in the -Command argument (double-escaping would turn
  // one quote into four).
  const inner = [
    `$a = New-ScheduledTaskAction -Execute '${launcherPath}'`,
    `$t = New-ScheduledTaskTrigger -AtLogon`,
    `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Trigger $t -RunLevel Highest -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${taskName}'`,
  ].join("; ");
  return `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','${_escapePs(inner)}' -Wait`;
}

// Register the logon task (UAC) and start it once so the worker comes up now.
// After this, every logon re-runs the task → worker auto-starts, no UAC.
function elevate() {
  return new Promise((resolve) => {
    const launcher = path.join(RUNTIME_DIR, ELEVATE_EXE);
    if (!existsSync(launcher)) { logger.error("elevate: launcher exe missing"); return resolve(false); }
    const ps = _buildElevateCmd(launcher, TASK_NAME);
    try {
      const p = spawn("powershell.exe",
        ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
        { windowsHide: true, stdio: "ignore" });
      p.on("exit", (code) => { if (code !== 0) logger.warn(`elevate: powershell exit=${code}`); resolve(code === 0); });
      p.on("error", (e) => { logger.error(`elevate: spawn error: ${e.message}`); resolve(false); });
    } catch (e) {
      logger.error(`elevate: throw: ${e.message}`);
      resolve(false);
    }
  });
}

// Delete the logon task (UAC) so the worker doesn't come back next boot.
function deleteTask() {
  return new Promise((resolve) => {
    const inner = `Unregister-ScheduledTask -TaskName '${_escapePs(TASK_NAME)}' -Confirm:$false -ErrorAction SilentlyContinue; exit 0`;
    const ps = `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','${_escapePs(inner)}' -Wait`;
    try {
      const p = spawn("powershell.exe",
        ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
        { windowsHide: true, stdio: "ignore" });
      p.on("exit", (code) => resolve(code === 0));
      p.on("error", () => resolve(false));
    } catch { resolve(false); }
  });
}

// Off: STOP the worker + remove the logon task so it stays off across reboots.
export async function uninstall() {
  if (!isWin) return { ok: false, reason: "unsupported" };
  setEnabled(false);
  try { await pipeCmd("STOP", 2000); }
  catch (e) { logger.warn(`uninstall: pipe STOP failed (${e.message})`); }
  await deleteTask();
  await sleep(500);
  const stillAlive = await isAlive();
  return { ok: !stillAlive, reason: stillAlive ? "worker_alive" : "stopped" };
}

// One-shot pipe command. Local pipe → fast; avoids stale persistent connections.
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

// Cached liveness — set by pipeCmd on connect (true) / error or timeout (false).
// Sync so remoteSocket + UI can read without awaiting.
let _running = false;

// Silent auto-update: only rebuilds the exe when the worker is NOT running
// (exe not locked, no UAC, no interruption). If the worker is running, leave
// it — the next toggle On / agent restart picks up the new binary via install().
export async function autoUpdate() {
  if (!isWin) return { ok: false, reason: "unsupported" };
  if (await isAlive()) return { ok: false, reason: "running" };
  if (!sourcesNewer()) return { ok: false, reason: "up_to_date" };
  if (await buildBinaries()) return { ok: true, reason: "rebuilt" };
  return { ok: false, reason: "build_failed" };
}

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

// Sync snapshot of last known liveness (updated by isAlive / pipeCmd side-effects).
export function isRunningCached() { return _running; }

// Build (if needed) + spawn the launcher (UAC) so it spawns the worker into
// the console session. Resolves once the worker's pipe is alive or after the
// wait budget (UAC denied / spawn failed). Worker upgrade: STOP → rebuild →
// respawn via the same UAC path.
export async function install() {
  if (!isWin) return { ok: false, reason: "unsupported" };
  let alive = await isAlive();
  const updateNeeded = alive && sourcesNewer();
  setEnabled(true);  // persist so a reboot can re-spawn the worker

  if (updateNeeded) {
    await stopWorker();              // free the locked exe so csc can overwrite
    _running = false;
    alive = false;
  }
  if (!await buildBinaries()) { logger.error("install: build failed"); return { ok: false, reason: "build_failed" }; }

  if (alive) return { ok: true, reason: "already_running" };

  // Worker dead (first install or just stopped for rebuild) → spawn via UAC.
  const elevated = await elevate();
  if (!elevated) { logger.warn("install: elevate failed (UAC denied?)"); return { ok: false, reason: "elevate_failed" }; }

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await isAlive()) return { ok: true, reason: updateNeeded ? "updated" : "started" };
  }
  logger.error("install: worker did not come up in time");
  diagnoseWorkerProcess();
  return { ok: false, reason: "worker_timeout" };
}

export async function getStatus() {
  return {
    supported: isWin,
    built: isBuilt(),
    running: await isAlive(),
  };
}

// Returns desktop name ("Winlogon" | "Default" | "none" | "unknown") or null on error.
export async function getDesktopState() {
  if (!isWin) return null;
  try {
    const r = await pipeCmd("STATE");
    _running = true;
    return r.replace(/^DESKTOP\s*/, "").trim();
  } catch { _running = false; return null; }
}

// Tail worker.log (written by the SYSTEM worker) — surfaces SendInput failures,
// wrong session/desktop, and per-char vk resolution so the agent can diagnose
// why typed text doesn't reach the login field.
function tailWorkerLog() {
  try {
    const p = path.join(RUNTIME_DIR, "worker.log");
    const lines = readFileSync(p, "utf8").trim().split(/\r?\n/);
    return lines.slice(-12).join(" | ") || "(empty)";
  } catch { return "(no worker log)"; }
}

export async function typeText(text) {
  if (!isWin) return { ok: false, reason: "unsupported" };
  if (typeof text !== "string" || !text) return { ok: false, reason: "empty" };
  // Pipe protocol is line-based — reject newlines so the worker reads the full
  // text on one ReadLine instead of truncating at the first \n.
  if (/[\r\n]/.test(text)) return { ok: false, reason: "newline_forbidden" };
  try {
    const r = await pipeCmd("TYPE " + text, 15000);
    _running = true;
    logger.info(`typeText: reply=${r} | worker: ${tailWorkerLog()}`);
    return { ok: r === "OK" };
  } catch (e) { _running = false; return { ok: false, reason: e.message }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
