// Emulator lifecycle — list AVDs, boot one, wait for it, shut it down.
// The web UI drives this so a device never has to be started by hand.

import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { EMULATOR, EMULATOR_ARGS, EMULATOR_ARGS_LOW_POWER, GPU_HOST_ARGS, QEMU_MEMORY_ARGS, ADB_TIMEOUTS, IDLE_SHUTDOWN_MS, IDLE_CHECK_MS } from "./constants.js";
import { connectionCount } from "../../api/ui.js";
import { PATHS } from "../../lib/constants.js";
import { findAdb, listDevices, listDevicesAsync, listSerials, listSerialsAsync } from "./adb.js";
import { promisify } from "util";
import { execFile } from "child_process";

const execFileAsync = promisify(execFile);
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("mobile");

let cachedEmulator;
// avdName → child process we spawned. Only these can be stopped by us.
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

/** Absolute path of the `emulator` binary, or null when the SDK lacks it. */
export function findEmulator() {
  if (cachedEmulator !== undefined) return cachedEmulator;
  const exe = process.platform === "win32" ? "emulator.exe" : "emulator";
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["emulator"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = probe.stdout.split("\n")[0]?.trim();
    if (first) { cachedEmulator = first; return cachedEmulator; }
  }
  cachedEmulator = sdkRoots().map((r) => path.join(r, "emulator", exe)).find((p) => fs.existsSync(p)) || null;
  return cachedEmulator;
}

/**
 * RAM an AVD is configured with, in MB, or null when it cannot be read. Read
 * from the AVD's own config so the value follows whatever the user chose —
 * hardcoding one would shrink a tablet and inflate a watch.
 */
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

/** AVD names configured on this host. Sync form: only off the hot path. */
export function listAvds() {
  const bin = findEmulator();
  if (!bin) return [];
  const r = spawnSync(bin, ["-list-avds"], { encoding: "utf8", timeout: ADB_TIMEOUTS.command });
  if (r.status !== 0) return [];
  return parseAvdList(r.stdout);
}

/** Same without blocking — ~30ms, and listAll runs on the UI's poll. */
export async function listAvdsAsync() {
  const bin = findEmulator();
  if (!bin) return [];
  try {
    const { stdout } = await execFileAsync(bin, ["-list-avds"], { timeout: ADB_TIMEOUTS.command });
    return parseAvdList(stdout);
  } catch { return []; }
}

// A running emulator reports its AVD name over the console socket, which is how
// a serial is matched back to the AVD the user picked.
function avdNameOf(serial) {
  const adb = findAdb();
  if (!adb) return null;
  // Short: the console answers early in boot, and a stall here would be paid
  // on every poll of every device.
  const r = spawnSync(adb, ["-s", serial, "emu", "avd", "name"], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trim()).find((l) => l && l !== "OK") || null;
}

async function avdNameOfAsync(serial) {
  const adb = findAdb();
  if (!adb) return null;
  try {
    const { stdout } = await execFileAsync(adb, ["-s", serial, "emu", "avd", "name"], { timeout: 3000 });
    return stdout.split("\n").map((l) => l.trim()).find((l) => l && l !== "OK") || null;
  } catch { return null; }
}

/**
 * Every device the UI can offer, as one list: configured AVDs (running or not)
 * plus physical devices. `serial` is null for an AVD that is powered off.
 *
 * Async throughout: the sync form spawned a getprop per device plus an emu
 * console call, ~320ms of blocked event loop, and the UI polls this every few
 * seconds while the mirror panel is open.
 */
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
      // Only an emulator we launched can be stopped without surprising the user.
      canStop: Boolean(live)
    });
  }

  // Physical devices, and any emulator not backed by a known AVD.
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

// AVDs currently booting — surfaced as state "starting" so the UI can show
// progress instead of an empty list.
const starting = new Set();

export function isStarting(avdName) {
  return starting.has(avdName);
}

/**
 * True when this agent launched the AVD behind `serial`. Actions that change
 * the device's own state — blanking its screen, stopping it — are limited to
 * these: a phone on USB, or an emulator the user opened themselves, is theirs.
 */
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
    // Short timeout — a booting device may not answer at all yet; that is a
    // "no", not something to wait 15s for on every poll.
    const { stdout } = await execFileAsync(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeout: 4000 });
    return stdout.trim() === "1";
  } catch { return false; }
}

/**
 * Boot an AVD and resolve once Android is actually usable (sys.boot_completed),
 * not merely when the process spawned — the UI waits on this to open the stream.
 * @param {(phase: string) => void} [onProgress]
 * @param {object} [opts] - { lowPower } runs the AVD without a window: far less
 *   host CPU, at a much lower frame rate. See EMULATOR_ARGS_LOW_POWER.
 */
export async function startAvd(avdName, onProgress, opts = {}) {
  const bin = findEmulator();
  if (!bin) throw new Error("Android emulator binary not found");
  if (!listAvds().includes(avdName)) throw new Error(`Unknown AVD: ${avdName}`);

  const existing = await bootedSerialFor(avdName);
  if (existing) return existing;
  if (starting.has(avdName)) throw new Error("Already starting");

  starting.add(avdName);
  try {
    // -gpu host is a large win where "auto" picks software rendering, but a
    // machine without a usable GPU can fail to boot with it. Try it, and fall
    // back to the emulator's own choice rather than assuming either way.
    try {
      return await bootOnce(bin, avdName, onProgress, opts, GPU_HOST_ARGS);
    } catch (err) {
      // Only retry when the flag itself looks like the problem. A boot that
      // timed out, or an AVD with a broken image, fails the same way without
      // -gpu host — retrying would double an already long wait and would
      // wrongly blacklist the flag on a machine that supports it.
      if (!err.gpuRejected || gpuHostUnsupported.has(bin)) throw err;
      gpuHostUnsupported.add(bin);
      logger.warn(`📱 -gpu host rejected (${err.message}); retrying with the emulator's default`);
      return await bootOnce(bin, avdName, onProgress, opts, []);
    }
  } finally {
    starting.delete(avdName);
  }
}

// Hosts where -gpu host has already failed once: retrying it on every launch
// would cost a full boot timeout each time.
const gpuHostUnsupported = new Set();

// ─── Idle shutdown ──────────────────────────────────────────────────────────
// Sleeping an emulator saves CPU but not its RAM, so an AVD left running with
// nobody connected still costs gigabytes. One watchdog for the whole agent, not
// per socket: the question is whether ANY client is connected.

// AVDs this agent started, recorded on disk. The emulator is spawned detached
// so it outlives an agent restart — without this the watchdog would forget it
// existed, and a forgotten AVD holds its gigabytes forever. Equally, it must
// not adopt an emulator the user opened themselves.
const OWNED_FILE = path.join(PATHS.STATE, "mobileOwnedAvds.json");

function readOwned() {
  try { return new Set(JSON.parse(fs.readFileSync(OWNED_FILE, "utf8"))); }
  catch { return new Set(); }
}

function writeOwned(names) {
  try {
    fs.mkdirSync(PATHS.STATE, { recursive: true });
    fs.writeFileSync(OWNED_FILE, JSON.stringify([...names]));
  } catch { /* losing the record only means an orphan survives */ }
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
  // Read from disk, not the in-memory map: an agent restart empties the map
  // while the detached emulator keeps running.
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

/** Armed whenever this agent starts an AVD; stands down once none are left. */
function startIdleWatch() {
  if (idleTimer) return;
  idleSince = null;
  idleTimer = setInterval(() => { checkIdle(); }, IDLE_CHECK_MS);
  // Never hold the process open just to watch for idleness.
  idleTimer.unref?.();
}

// An agent restart leaves the previous run's emulators running (they are
// detached). Pick the watch back up so they are still reclaimed, rather than
// living on until someone notices the memory.
if (readOwned().size > 0) startIdleWatch();

async function bootOnce(bin, avdName, onProgress, opts, gpuArgs) {
  onProgress?.("launching");
  const args = opts.lowPower ? EMULATOR_ARGS_LOW_POWER : EMULATOR_ARGS;
  const gpu = gpuHostUnsupported.has(bin) ? [] : gpuArgs;
  // -qemu must come last: everything after it is passed to QEMU verbatim.
  const memArgs = QEMU_MEMORY_ARGS(avdRamSizeMb(avdName));
  const child = spawn(bin, ["-avd", avdName, ...args, ...gpu, ...memArgs], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.unref();
  running.set(avdName, child);

  // The emulator logs GPU/driver info to stderr on a healthy boot, so stderr is
  // NOT a failure signal — only a non-zero exit is. Keep the tail for the message.
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
      // An unsupported flag makes the emulator quit almost immediately, before
      // a device ever appears. Anything slower is a different problem.
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

/** Graceful shutdown via the emulator console; SIGKILL only if it refuses. */
export async function stopAvd(serial) {
  const adb = findAdb();
  if (!adb) throw new Error("adb not found");
  const avdName = await avdNameOfAsync(serial);
  // Async like the rest: a 100ms freeze while another device is mirroring
  // shows up as a stutter in that stream.
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
