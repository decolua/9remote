import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { EMULATOR, EMULATOR_ARGS, EMULATOR_ARGS_LOW_POWER, GPU_HOST_ARGS, QEMU_MEMORY_ARGS, ADB_TIMEOUTS, IDLE_SHUTDOWN_MS, IDLE_CHECK_MS, SDK_SETUP } from "./constants.js";
import { connectionCount } from "../../api/ui.js";
import { PATHS } from "../../lib/constants.js";
import { findAdb, listDevices, listDevicesAsync, listSerials, listSerialsAsync } from "./adb.js";
import { promisify } from "util";
import { execFile } from "child_process";

const execFileAsync = promisify(execFile);
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("mobile");

let cachedEmulator;
let probedAt = 0;
const running = new Map();

export function sdkRoots() {
  const home = os.homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, "Library/Android/sdk"),
    path.join(home, "Android/Sdk"),
    path.join(home, "AppData/Local/Android/Sdk")
  ].filter(Boolean);
}

export function findEmulator() {
  if (cachedEmulator !== undefined && (cachedEmulator || Date.now() - probedAt < SDK_SETUP.reprobeMs)) return cachedEmulator;
  probedAt = Date.now();
  const exe = process.platform === "win32" ? "emulator.exe" : "emulator";
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["emulator"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = probe.stdout.split("\n")[0]?.trim();
    if (first) { cachedEmulator = first; return cachedEmulator; }
  }
  cachedEmulator = sdkRoots().map((r) => path.join(r, "emulator", exe)).find((p) => fs.existsSync(p)) || null;
  return cachedEmulator;
}

export function resetEmulatorCache() {
  cachedEmulator = undefined;
  probedAt = 0;
}

function avdRamSizeMb(avdName) {
  for (const root of [process.env.ANDROID_AVD_HOME, path.join(os.homedir(), ".android", "avd")].filter(Boolean)) {
    const ini = path.join(root, `${avdName}.avd`, "config.ini");
    if (!fs.existsSync(ini)) continue;
    const m = fs.readFileSync(ini, "utf8").match(/^hw\.ramSize\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  }
  return null;
}

export function canManageEmulators() {
  return Boolean(findEmulator());
}

function parseAvdList(out) {
  return out.split("\n").map((l) => l.trim()).filter((l) => l && !l.includes(" "));
}

export function listAvds() {
  const bin = findEmulator();
  if (!bin) return [];
  const r = spawnSync(bin, ["-list-avds"], { encoding: "utf8", timeout: ADB_TIMEOUTS.command });
  if (r.status !== 0) return [];
  return parseAvdList(r.stdout);
}

export async function listAvdsAsync() {
  const bin = findEmulator();
  if (!bin) return [];
  try {
    const { stdout } = await execFileAsync(bin, ["-list-avds"], { timeout: ADB_TIMEOUTS.command });
    return parseAvdList(stdout);
  } catch { return []; }
}

function avdNameOf(serial) {
  const adb = findAdb();
  if (!adb) return null;
  const r = spawnSync(adb, ["-s", serial, "emu", "avd", "name"], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trim()).find((l) => l && l !== "OK") || null;
}

export async function avdNameOfAsync(serial) {
  const adb = findAdb();
  if (!adb) return null;
  try {
    const { stdout } = await execFileAsync(adb, ["-s", serial, "emu", "avd", "name"], { timeout: 3000 });
    return stdout.split("\n").map((l) => l.trim()).find((l) => l && l !== "OK") || null;
  } catch { return null; }
}

export async function listAll() {
  const online = await listDevicesAsync();
  const bySerial = new Map();
  for (const d of online) {
    bySerial.set(d.serial, { ...d, avdName: d.isEmulator ? await avdNameOfAsync(d.serial) : null });
  }

  const out = [];
  const claimed = new Set();
  for (const avd of await listAvdsAsync()) {
    const live = [...bySerial.values()].find((d) => d.avdName === avd);
    if (live) claimed.add(live.serial);
    out.push({
      id: `avd:${avd}`,
      avdName: avd,
      name: avd.replace(/_/g, " "),
      serial: live?.serial ?? null,
      state: live ? "running" : (starting.has(avd) ? "starting" : "stopped"),
      kind: "emulator",
      canStop: Boolean(live)
    });
  }

  for (const [serial, d] of bySerial) {
    if (claimed.has(serial)) continue;
    out.push({
      id: `dev:${serial}`,
      avdName: d.avdName,
      name: d.name || serial,
      serial,
      state: "running",
      kind: d.isEmulator ? "emulator" : "physical",
      canStop: false
    });
  }
  return out;
}

const starting = new Set();

export function isStarting(avdName) {
  return starting.has(avdName);
}

export async function isAgentStarted(serial) {
  if (!serial?.startsWith("emulator-")) return false;
  const owned = readOwned();
  if (owned.size === 0) return false;
  const avdName = await avdNameOfAsync(serial);
  return Boolean(avdName && owned.has(avdName));
}

async function bootedSerialFor(avdName) {
  for (const d of await listSerialsAsync()) {
    if (d.serial.startsWith("emulator-") && await avdNameOfAsync(d.serial) === avdName) return d.serial;
  }
  return null;
}

async function isBootCompleted(serial) {
  const adb = findAdb();
  if (!adb) return false;
  try {
    const { stdout } = await execFileAsync(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeout: 4000 });
    return stdout.trim() === "1";
  } catch { return false; }
}

export async function startAvd(avdName, onProgress, opts = {}) {
  const bin = findEmulator();
  if (!bin) throw new Error("Android emulator binary not found");
  if (!listAvds().includes(avdName)) throw new Error(`Unknown AVD: ${avdName}`);

  const existing = await bootedSerialFor(avdName);
  if (existing) return existing;
  if (starting.has(avdName)) throw new Error("Already starting");

  starting.add(avdName);
  try {
    // Try -gpu host first; fall back to default if unsupported.
    try {
      return await bootOnce(bin, avdName, onProgress, opts, GPU_HOST_ARGS);
    } catch (err) {
      if (!err.gpuRejected || gpuHostUnsupported.has(bin)) throw err;
      gpuHostUnsupported.add(bin);
      logger.warn(`📱 -gpu host rejected (${err.message}); retrying with the emulator's default`);
      return await bootOnce(bin, avdName, onProgress, opts, []);
    }
  } finally {
    starting.delete(avdName);
  }
}

const gpuHostUnsupported = new Set();

const OWNED_FILE = path.join(PATHS.STATE, "mobileOwnedAvds.json");

function readOwned() {
  try { return new Set(JSON.parse(fs.readFileSync(OWNED_FILE, "utf8"))); }
  catch { return new Set(); }
}

function writeOwned(names) {
  try {
    fs.mkdirSync(PATHS.STATE, { recursive: true });
    fs.writeFileSync(OWNED_FILE, JSON.stringify([...names]));
  } catch {}
}

function markOwned(avdName) {
  const owned = readOwned();
  if (owned.has(avdName)) return;
  owned.add(avdName);
  writeOwned(owned);
}

function unmarkOwned(avdName) {
  const owned = readOwned();
  if (!owned.delete(avdName)) return;
  writeOwned(owned);
}

let idleSince = null;
let idleTimer = null;

function stopIdleWatch() {
  clearInterval(idleTimer);
  idleTimer = null;
  idleSince = null;
}

async function checkIdle() {
  const owned = readOwned();
  if (owned.size === 0) { stopIdleWatch(); return; }
  if (connectionCount() > 0) { idleSince = null; return; }
  if (idleSince === null) { idleSince = Date.now(); return; }
  if (Date.now() - idleSince < IDLE_SHUTDOWN_MS) return;

  const minutes = Math.round(IDLE_SHUTDOWN_MS / 60000);
  for (const avdName of owned) {
    const serial = await bootedSerialFor(avdName);
    if (!serial) { unmarkOwned(avdName); running.delete(avdName); continue; }
    logger.info(`📱 No client for ${minutes} min — stopping ${avdName}`);
    try { await stopAvd(serial); } catch (e) { logger.warn(`idle stop failed: ${e.message}`); }
  }
  stopIdleWatch();
}

function startIdleWatch() {
  if (idleTimer) return;
  idleSince = null;
  idleTimer = setInterval(() => { checkIdle(); }, IDLE_CHECK_MS);
  idleTimer.unref?.();
}

if (readOwned().size > 0) startIdleWatch();

async function bootOnce(bin, avdName, onProgress, opts, gpuArgs) {
  onProgress?.("launching");
  const args = opts.lowPower ? EMULATOR_ARGS_LOW_POWER : EMULATOR_ARGS;
  const gpu = gpuHostUnsupported.has(bin) ? [] : gpuArgs;
  // -qemu must come last: arguments after it are passed to QEMU directly.
  const memArgs = QEMU_MEMORY_ARGS(avdRamSizeMb(avdName));
  const child = spawn(bin, ["-avd", avdName, ...args, ...gpu, ...memArgs], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.unref();
  running.set(avdName, child);

  // Emulator logs GPU/driver info to stderr on healthy boot; only non-zero exit is failure.
  let stderrTail = "";
  let exitError = null;
  child.stderr?.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-400); });
  child.on("exit", (code) => {
    running.delete(avdName);
    if (code !== 0) {
      const hint = stderrTail.split("\n").filter((l) => /error|failed|cannot/i.test(l)).pop();
      exitError = hint?.trim().slice(0, 200) || `emulator exited with code ${code}`;
    }
  });

  const deadline = Date.now() + EMULATOR.bootTimeoutMs;
  const launchedAt = Date.now();
  let sawSerial = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, EMULATOR.bootPollMs));
    if (exitError) {
      const failed = new Error(exitError);
      failed.gpuRejected = gpuArgs.length > 0 && !sawSerial
        && Date.now() - launchedAt < EMULATOR.flagRejectMs;
      throw failed;
    }
    const serial = sawSerial || await bootedSerialFor(avdName);
    if (serial) {
      if (!sawSerial) { sawSerial = serial; onProgress?.("booting"); }
      if (await isBootCompleted(serial)) {
        onProgress?.("ready");
        markOwned(avdName);
        startIdleWatch();
        logger.info(`📱 AVD ${avdName} booted → ${serial}${opts.lowPower ? " (low power)" : ""}`);
        return serial;
      }
    }
  }
  throw new Error(`${avdName} did not finish booting in ${Math.round(EMULATOR.bootTimeoutMs / 1000)}s`);
}

export async function stopAvd(serial) {
  const adb = findAdb();
  if (!adb) throw new Error("adb not found");
  const avdName = await avdNameOfAsync(serial);
  try { await execFileAsync(adb, ["-s", serial, "emu", "kill"], { timeout: 10_000 }); } catch { /* already gone */ }

  const deadline = Date.now() + EMULATOR.shutdownTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await listSerialsAsync()).some((d) => d.serial === serial)) {
      if (avdName) { running.delete(avdName); unmarkOwned(avdName); }
      logger.info(`📱 AVD ${avdName || serial} stopped`);
      return true;
    }
  }
  const child = avdName && running.get(avdName);
  if (child) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } running.delete(avdName); }
  return !(await listSerialsAsync()).some((d) => d.serial === serial);
}
