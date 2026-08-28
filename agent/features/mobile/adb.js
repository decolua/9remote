// adb wrapper — device discovery, jar push, port forwarding, AVD control.
// Everything here shells out to the `adb` on PATH (or ANDROID_HOME); the feature
// stays hidden when it is missing rather than erroring.

import { spawnSync, spawn, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import path from "path";
import fs from "fs";
import os from "os";
import { ADB_TIMEOUTS } from "./constants.js";

let cachedAdb;

// Android SDK layouts, in the order the tools themselves prefer them.
function sdkCandidates() {
  const home = os.homedir();
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, "Library/Android/sdk"),
    path.join(home, "Android/Sdk"),
    path.join(home, "AppData/Local/Android/Sdk")
  ].filter(Boolean);
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  return roots.map((root) => path.join(root, "platform-tools", exe));
}

/** Absolute adb path, or null when Android tooling is not installed. */
export function findAdb() {
  if (cachedAdb !== undefined) return cachedAdb;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["adb"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = probe.stdout.split("\n")[0]?.trim();
    if (first) { cachedAdb = first; return cachedAdb; }
  }
  cachedAdb = sdkCandidates().find((p) => fs.existsSync(p)) || null;
  return cachedAdb;
}

export function isAvailable() {
  return Boolean(findAdb());
}

function run(args, opts = {}) {
  const adb = findAdb();
  if (!adb) throw new Error("adb not found — install Android platform-tools");
  return spawnSync(adb, args, { encoding: "utf8", timeout: ADB_TIMEOUTS.command, ...opts });
}

function runOrThrow(args, opts) {
  const r = run(args, opts);
  if (r.status !== 0) throw new Error(`adb ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

// `adb devices` takes ~80ms and a labelled listing ~320ms. spawnSync blocks the
// whole event loop for that long — no video frames read or sent, no input
// delivered, the terminal frozen too. Anything on a timer must use these.
async function runAsync(args, opts = {}) {
  const adb = findAdb();
  if (!adb) throw new Error("adb not found — install Android platform-tools");
  const { stdout } = await execFileAsync(adb, args, { timeout: ADB_TIMEOUTS.command, ...opts });
  return stdout;
}

function parseDeviceList(out) {
  return out
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    })
    .filter((d) => d.state === "device")
    .map((d) => ({ ...d, isEmulator: d.serial.startsWith("emulator-") }));
}

/**
 * Serials only — one `adb devices` call, no per-device shell. Boot polling uses
 * this: getprop against a half-booted device blocks until the command timeout,
 * which would stretch every poll into tens of seconds.
 * Synchronous: only for the boot loop, which already runs off the hot path.
 */
export function listSerials() {
  return parseDeviceList(runOrThrow(["devices"]));
}

/** Same, without blocking the event loop. Use this anywhere on a timer. */
export async function listSerialsAsync() {
  return parseDeviceList(await runAsync(["devices"]));
}

/** Booted devices with a display name — costs a few getprop per device. */
export function listDevices() {
  return listSerials().map((d) => ({ ...d, name: deviceLabel(d.serial) }));
}

/** Labelled listing without blocking: the getprop calls run concurrently. */
export async function listDevicesAsync() {
  const devices = await listSerialsAsync();
  return Promise.all(devices.map(async (d) => ({ ...d, name: await deviceLabelAsync(d.serial) })));
}

async function deviceLabelAsync(serial) {
  const prop = async (key) => {
    try {
      const out = await runAsync(["-s", serial, "shell", "getprop", key], { timeout: 3000 });
      return out.trim();
    } catch { return ""; }
  };
  // Sequential on purpose: the first key usually answers, so the later ones
  // are never spawned on an emulator.
  return (await prop("ro.kernel.qemu.avd_name"))
    || (await prop("ro.boot.qemu.avd_name"))
    || (await prop("ro.product.model"))
    || serial;
}

// Emulators report their AVD name; physical devices report the marketing model.
// Short timeout: a device mid-boot answers slowly, and a name is not worth a stall.
function deviceLabel(serial) {
  const prop = (key) => run(["-s", serial, "shell", "getprop", key], { timeout: 3000 }).stdout?.trim() || "";
  return prop("ro.kernel.qemu.avd_name") || prop("ro.boot.qemu.avd_name") || prop("ro.product.model") || serial;
}

export async function pushJar(serial, localJar, devicePath) {
  await runAsync(["-s", serial, "push", localJar, devicePath]);
}

export function removeForward(serial, port) {
  const r = run(["-s", serial, "forward", "--remove", `tcp:${port}`]);
  if (r.status !== 0 && !(r.stderr || "").includes("cannot remove listener")) {
    throw new Error(`adb forward --remove tcp:${port} failed: ${(r.stderr || "").trim()}`);
  }
}

function forwardedPort(serial, target) {
  const r = run(["-s", serial, "forward", "--list"]);
  if (r.status !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+tcp:(\d+)\s+(.+)$/);
    if (m && m[1] === serial && m[3] === target) return Number(m[2]);
  }
  return null;
}

/** Map an on-device abstract socket to a host TCP port; returns the port. */
export async function forwardAbstract(serial, name) {
  const target = `localabstract:${name}`;
  let out;
  try { out = await runAsync(["-s", serial, "forward", "tcp:0", target]); }
  catch (e) { throw new Error(`adb forward failed: ${e.message}`); }
  const port = Number(out.trim()) || forwardedPort(serial, target);
  if (!Number.isInteger(port) || port <= 0) throw new Error("adb did not return a forwarded port");
  return port;
}

/**
 * True once the device-side abstract socket exists — dialing in earlier gets a
 * phantom EOF. Async because the wait loop calls it every 100ms.
 */
export async function hasAbstractSocket(serial, name) {
  try {
    const out = await runAsync(["-s", serial, "shell", "cat", "/proc/net/unix"]);
    return out.includes(`@${name}`);
  } catch { return false; }
}

export function spawnShell(serial, args) {
  const adb = findAdb();
  if (!adb) throw new Error("adb not found");
  return spawn(adb, ["-s", serial, "shell", ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Physical screen size in px — reported to the client, not used for input. */
export async function getScreenSize(serial) {
  try {
    const out = await runAsync(["-s", serial, "shell", "wm", "size"]);
    const m = out.match(/Physical size:\s*(\d+)x(\d+)/);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  } catch { return null; }
}
