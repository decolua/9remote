// Windows desktop bridge orchestrator — builds the worker/launcher, registers a
// boot-time scheduled task that spawns the SYSTEM worker, and exposes a tiny
// pipe client for desktop state detection + text typing (used to unlock the
// login screen remotely).
//
// Boot persistence: an AtStartup task running as SYSTEM launches
// desktop-elevate.exe, which duplicates the console-session winlogon token so
// the worker lands on the user's Winlogon desktop (not session 0). AtStartup —
// not AtLogon — because a rebooted machine sits at the lock screen with nobody
// logged on, which is exactly when remote unlock is needed.
//
// UAC is prompted ONLY when the user toggles the feature On/Off. Agent startup
// never elevates and never stops a healthy worker.
//
// Mirrors the ptyDaemon runtime pattern: .cs sources ship inside the package,
// .exe artifacts live in ~/.9remote/bin/ (PATHS.BIN) so they never lock files
// in node_modules/9remote and survive `npm i -g 9remote@latest` (autoupdate).
// The worker runs as Local System, independent of the agent process — autoupdate
// only kills cloudflared + agent PIDs, never this worker.

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

// Persisted "user toggled On" flag — the user's INTENT, independent of whether
// the worker happens to be running. Boot persistence comes from the scheduled
// task, so the agent never needs to elevate at startup to honour this flag.
const ENABLED_FLAG = path.join(PATHS.ROOT, "unlock.enabled");
export function isEnabled() { return existsSync(ENABLED_FLAG); }
function setEnabled(v) {
  try {
    if (v) writeFileSync(ENABLED_FLAG, "1");
    else unlinkSync(ENABLED_FLAG);
  } catch (e) { logger.warn(`setEnabled(${v}) failed: ${e.message}`); }
}

// Version declared by the shipped worker source. Null if unreadable.
function sourceVersion() {
  try { return _parseVersion(readFileSync(path.join(SOURCE_DIR, BRIDGE_CS), "utf8")); }
  catch { return null; }
}

// Runtime path of the worker exe for the shipped version (may not exist yet).
function bridgeExePath() {
  const v = sourceVersion();
  return v ? path.join(RUNTIME_DIR, _exeNameFor(v)) : null;
}

export function isBuilt() {
  const bridge = bridgeExePath();
  return !!bridge && existsSync(bridge) && existsSync(path.join(RUNTIME_DIR, ELEVATE_EXE));
}

// Ask the running worker its version.
// Returns {version, reachable}: a reply of "ERR unknown" means a live worker
// that predates the VERSION command (stale), whereas no reply at all means the
// pipe was busy or gone (unknown). _isWorkerStale treats those differently.
async function probeWorkerVersion() {
  if (!isWin) return { version: null, reachable: false };
  try {
    const r = await pipeCmd("VERSION", 1500);
    const m = /^VERSION\s+(\S+)/.exec(r.trim());
    return { version: m ? m[1] : null, reachable: true };
  } catch { return { version: null, reachable: false }; }
}

// Shared by install() and getStatus() — one probe, one verdict.
async function checkStale() {
  const { version, reachable } = await probeWorkerVersion();
  return _isWorkerStale({ workerVersion: version, sourceVersion: sourceVersion(), reachable });
}

// Delete superseded desktop-bridge-<n>.exe builds. Best-effort: the copy still
// running is locked by Windows and simply fails to unlink — retried next build,
// once a reboot has moved the worker onto the newer exe.
function pruneOldExes(keepName) {
  try {
    for (const f of readdirSync(RUNTIME_DIR)) {
      // Also drops the pre-versioning desktop-bridge.exe left by older agents.
      const obsolete = /^desktop-bridge-\d+\.exe$/.test(f) || f === "desktop-bridge.exe";
      if (!obsolete || f === keepName) continue;
      try { unlinkSync(path.join(RUNTIME_DIR, f)); } catch {}
    }
  } catch {}
}

// Ask the running worker to exit gracefully (frees the locked .exe for rebuild).
// Poll until the pipe stops answering — a STATE reply means it is still up, so
// keep waiting rather than returning on the first probe. Returns true if gone.
// The pipe closes slightly before the process exits and releases its mutex, so
// a replacement worker can start while the old one still holds the lock. That
// gap is closed on the worker side: a starting instance waits out the handoff
// (HANDOFF_WAIT_MS in desktop-bridge.cs) instead of exiting immediately.
async function stopWorker() {
  try { await pipeCmd("STOP", 2000); } catch {}
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    try { await pipeCmd("STATE", 600); } catch { return true; }
  }
  return false;
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

// Copy .cs → runtime dir + compile via csc. Idempotent: skips when the target
// exe already exists. Returns true on success.
//
// The worker exe is version-stamped (desktop-bridge-<v>.exe), so a rebuild never
// touches the copy currently running — no file lock, no need to stop the worker,
// no UAC. The launcher picks the highest version at next boot.
// The launcher exe keeps a fixed name: it exits immediately after spawning the
// worker, so it is never locked and can be overwritten in place.
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
    // Versioned worker: existence alone means it's current (name encodes the
    // version). The launcher is unversioned, so always recompile it.
    if (exe !== ELEVATE_EXE && existsSync(rtExe)) continue;
    copyFileSync(srcCs, rtCs);
    const r = await runHidden(csc, ["-nologo", "-target:winexe", `-out:${rtExe}`, rtCs]);
    if (!r.ok) { logger.error(`csc build failed for ${cs}: ${r.err}`); return false; }
  }
  pruneOldExes(_exeNameFor(version));
  return true;
}


// Best-effort: is the worker process alive even though the pipe is dead?
// Distinguishes "task never started" from "worker spawned then crashed".
function diagnoseWorkerProcess() {
  try {
    const p = spawn("cmd.exe",
      // Wildcard: the worker exe is version-stamped (desktop-bridge-<v>.exe), so
      // an exact-name filter would report NOT RUNNING for a perfectly live worker.
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

// --- PowerShell helpers (exported as _* for unit testing) ---
// Escape a string for safe embedding inside a PowerShell single-quoted string.
export function _escapePs(s) { return String(s).replace(/'/g, "''"); }

// Boot task name. Exported so tests and diagnostics reference one constant.
export const TASK_NAME = "9remoteDesktopUnlock";

// Register + start the AtStartup SYSTEM task that launches desktop-elevate.exe.
// -AtStartup (not -AtLogon): after a reboot nobody is logged on — the machine
// sits at the lock screen, which is precisely when remote unlock is needed.
// The launcher then duplicates the console-session winlogon token, so the worker
// still lands on the user's interactive desktop rather than session 0.
// New-ScheduledTaskAction -Execute takes the path natively, so paths with
// spaces need no cmdline quoting (the schtasks /TR footgun).
export function _buildInstallTaskCmd(launcherPath, taskName) {
  const inner = [
    `$a = New-ScheduledTaskAction -Execute '${_escapePs(launcherPath)}'`,
    `$t = New-ScheduledTaskTrigger -AtStartup`,
    `$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest`,
    // Daemon: no time limit, and never stopped for running "too long".
    `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `Register-ScheduledTask -TaskName '${_escapePs(taskName)}' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${_escapePs(taskName)}'`
  ].join("; ");
  return `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','${_escapePs(inner)}' -Wait`;
}

// Remove the boot task so the worker stays off across reboots.
export function _buildDeleteTaskCmd(taskName) {
  const inner = `Unregister-ScheduledTask -TaskName '${_escapePs(taskName)}' -Confirm:$false -ErrorAction SilentlyContinue; exit 0`;
  return `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','${_escapePs(inner)}' -Wait`;
}

// Should install() raise a UAC prompt? Only when admin is actually required:
// the boot task is missing (a reboot would lose the worker), or the worker is
// down and needs starting. Re-toggling On with both healthy is a silent no-op.
export function _shouldElevate({ alive, hasTask }) { return !alive || !hasTask; }

// --- Versioning (mirrors DAEMON_VERSION for the pty daemon) ---
// The shipped .cs declares `const string VERSION = "n"`. mtime comparison used
// to fill this role and was unreliable: copyFileSync restamps the copy, npm
// unpack order isn't guaranteed, clocks skew.
export function _parseVersion(src) {
  if (!src) return null;
  const m = /const\s+string\s+VERSION\s*=\s*"([^"]+)"/.exec(src);
  return m ? m[1] : null;
}

// Version-stamped worker filename. Building under a NEW name means the copy
// currently running is never overwritten — no file lock, so no STOP and no UAC
// just to rebuild (overwriting is what produced csc CS0016 before).
export function _exeNameFor(version) { return `desktop-bridge-${version}.exe`; }

// Highest desktop-bridge-<n>.exe from a directory listing, or null.
// Numeric compare — lexicographic would rank "9" above "10". Mirrors
// PickNewestWorker in desktop-elevate.cs; keep both in step.
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

// Is the running worker behind the shipped source?
// `reachable` distinguishes the two ways workerVersion can be null:
//   reachable + null → worker answered "ERR unknown", predates VERSION → stale.
//   unreachable      → the probe timed out. The pipe is single-threaded, so a
//                      long TYPE blocks VERSION for seconds; that is UNKNOWN,
//                      not old, and stopping a current worker over it is worse
//                      than waiting. Same reasoning as the lock poll's debounce.
// An unreadable source also yields false: never churn on a bad read.
export function _isWorkerStale({ workerVersion, sourceVersion, reachable = true }) {
  if (!sourceVersion) return false;
  if (!reachable) return false;
  if (!workerVersion) return true;
  return parseInt(workerVersion, 10) < parseInt(sourceVersion, 10);
}

// Run a PowerShell command hidden. Resolves true on exit code 0 (for the UAC
// wrappers: the user accepted the prompt and the inner script ran).
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

// Is the boot task registered? Exit code 0 → present. No UAC (query is read-only).
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

// Register the boot task + start it now (single UAC prompt).
function installBootTask() {
  const launcher = path.join(RUNTIME_DIR, ELEVATE_EXE);
  if (!existsSync(launcher)) { logger.error("installBootTask: launcher exe missing"); return Promise.resolve(false); }
  return runPs(_buildInstallTaskCmd(launcher, TASK_NAME), "installBootTask");
}

// Off: STOP the worker + delete the boot task so it stays off across reboots.
// One UAC prompt (task removal); the STOP itself needs no elevation.
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

// User toggled On. Registers the AtStartup boot task (so the worker survives
// reboot) and starts it now. This is the ONLY path that raises a UAC prompt —
// agent startup never calls it.
//
// Ordering matters: check liveness BEFORE building. A running worker holds a
// lock on desktop-bridge.exe, so compiling first would fail with CS0016 and
// abort the whole install even when nothing needed rebuilding.
export async function install() {
  if (!isWin) return { ok: false, reason: "unsupported" };
  setEnabled(true);  // user intent, persisted independently of worker liveness

  let alive = await isAlive();
  const hasTask = await hasBootTask();
  const stale = await checkStale();

  // Build first: version-stamped output never collides with the running worker,
  // so this is safe whether or not one is alive. No stop, no lock, no UAC.
  if (!isBuilt() && !await buildBinaries()) {
    logger.error("install: build failed");
    return { ok: false, reason: "build_failed" };
  }

  // A stale worker needs replacing, not just starting: stop it so the task
  // relaunch picks the newly built exe. STOP goes over the pipe — no elevation.
  if (stale && alive) {
    if (!await stopWorker()) {
      logger.warn("install: stale worker did not stop");
      return { ok: false, reason: "stop_failed" };
    }
    _running = false;
    alive = false;
  }

  if (!_shouldElevate({ alive, hasTask })) return { ok: true, reason: "already_running" };

  // One UAC prompt: register the boot task + start it now.
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
    // enabled = user intent (persisted, survives reboot); running = worker
    // liveness right now. The toggle reflects intent so a transient worker
    // restart doesn't make the switch flip itself back to Off.
    enabled: isEnabled(),
    running: await isAlive(),
    // Worker is older than the shipped source (agent was updated). Read-only —
    // surfacing it lets the UI offer an update instead of silently running an
    // outdated worker until the user happens to toggle Off/On.
    stale: await checkStale(),
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

export async function typeText(text) {
  if (!isWin) return { ok: false, reason: "unsupported" };
  if (typeof text !== "string" || !text) return { ok: false, reason: "empty" };
  // Pipe protocol is line-based — reject newlines so the worker reads the full
  // text on one ReadLine instead of truncating at the first \n.
  if (/[\r\n]/.test(text)) return { ok: false, reason: "newline_forbidden" };
  try {
    const r = await pipeCmd("TYPE " + text, 15000);
    _running = true;
    return { ok: r === "OK" };
  } catch (e) { _running = false; return { ok: false, reason: e.message }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
