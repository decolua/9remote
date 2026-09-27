// App management over adb — install, launch, clear, uninstall, deep links.
// The dev loop the web UI drives: drop an APK, launch it, watch it, repeat.

import { spawnSync, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import path from "path";
import fs from "fs";
import os from "os";
import { findAdb } from "./adb.js";
import { sdkRoots } from "./emulator.js";
import { ADB_TIMEOUTS, APK_STAGE_DIR, APK_MAX_BYTES } from "./constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("mobile");

// Install can take minutes for a large APK — well past the usual adb timeout.
const INSTALL_TIMEOUT_MS = 300_000;

function adb(serial, args, opts = {}) {
  const bin = findAdb();
  if (!bin) throw new Error("adb not found");
  return spawnSync(bin, ["-s", serial, ...args], {
    encoding: "utf8", timeout: ADB_TIMEOUTS.command, ...opts
  });
}

// A package name is used unquoted in adb argv (never a shell), but keep it to
// the documented grammar so a crafted value can't turn into a second argument.
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

function assertPackage(pkg) {
  if (typeof pkg !== "string" || !PACKAGE_RE.test(pkg) || pkg.length > 255) {
    throw new Error("Invalid package name");
  }
  return pkg;
}

// Async: this runs while a stream is live, and a sync spawn per package froze
// the whole agent — video and input included — for a couple of hundred ms.
async function adbAsync(serial, args, opts = {}) {
  const bin = findAdb();
  if (!bin) throw new Error("adb not found");
  const { stdout } = await execFileAsync(bin, ["-s", serial, ...args], {
    timeout: ADB_TIMEOUTS.command, maxBuffer: 8 * 1024 * 1024, ...opts
  });
  return stdout;
}

/** Third-party packages, with the launchable activity when there is one. */
export async function listApps(serial) {
  let out;
  try { out = await adbAsync(serial, ["shell", "pm", "list", "packages", "-3"]); }
  catch (e) { throw new Error(`pm list failed: ${e.message}`); }
  const packages = out.split("\n")
    .map((l) => l.trim().replace(/^package:/, ""))
    .filter((p) => PACKAGE_RE.test(p));

  // Concurrent: the list is short (user-installed only), and serialising the
  // resolves was most of this call's cost.
  return Promise.all(packages.map(async (pkg) => {
    let activity = null;
    try {
      const res = await adbAsync(serial, ["shell", "cmd", "package", "resolve-activity", "--brief", pkg], { timeout: 5000 });
      activity = res.split("\n").map((l) => l.trim()).find((l) => l.includes("/")) || null;
    } catch { /* no launcher activity */ }
    return { packageName: pkg, activity, launchable: Boolean(activity) };
  }));
}

/** The package whose activity is in the foreground — used to label the stream. */
export async function foregroundApp(serial) {
  try {
    const out = await adbAsync(serial, ["shell", "dumpsys", "activity", "activities"], { timeout: 8000 });
    const m = out.match(/topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)\/(\S+)/);
    return m ? { packageName: m[1], activity: `${m[1]}/${m[2]}` } : null;
  } catch { return null; }
}

/**
 * Install an APK already staged on the host filesystem. `-r` upgrades in place
 * so an iteration keeps the app's data; `-t` allows test-only builds, which is
 * what a debug build from a dev machine usually is.
 */
export function installApk(serial, apkPath) {
  if (!fs.existsSync(apkPath)) throw new Error("APK not found");
  const r = adb(serial, ["install", "-r", "-t", apkPath], { timeout: INSTALL_TIMEOUT_MS });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status !== 0 || /Failure|Error/i.test(out)) {
    // adb prints the real reason (INSTALL_FAILED_*) rather than using exit codes.
    const reason = out.match(/(INSTALL_FAILED_\w+|Failure \[[^\]]+\]|Error:[^\n]+)/)?.[1];
    throw new Error(reason || out.trim().slice(0, 200) || "Install failed");
  }
  const pkg = packageOfApk(apkPath);
  logger.info(`📱 Installed ${pkg || path.basename(apkPath)}`);
  return { packageName: pkg };
}

// Read the package name out of the APK so the UI can offer "Launch" right after
// an install. Located via the SDK roots, not relative to adb: a Homebrew adb in
// /usr/local/bin has no build-tools beside it. aapt2 is optional, so a miss is
// not an error — the install still succeeded.
function packageOfApk(apkPath) {
  const exe = process.platform === "win32" ? "aapt2.exe" : "aapt2";
  for (const root of sdkRoots()) {
    const buildTools = path.join(root, "build-tools");
    if (!fs.existsSync(buildTools)) continue;
    // Newest build-tools first — older aapt2 may not parse a modern APK.
    for (const version of fs.readdirSync(buildTools).sort().reverse()) {
      const bin = path.join(buildTools, version, exe);
      if (!fs.existsSync(bin)) continue;
      const r = spawnSync(bin, ["dump", "packagename", apkPath], { encoding: "utf8", timeout: 15_000 });
      const name = r.stdout?.trim().split("\n")[0];
      if (r.status === 0 && name && PACKAGE_RE.test(name)) return name;
    }
  }
  return null;
}

export function uninstallApp(serial, pkg) {
  assertPackage(pkg);
  const r = adb(serial, ["uninstall", pkg], { timeout: 60_000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status !== 0 || /Failure/i.test(out)) throw new Error(out.trim().slice(0, 200) || "Uninstall failed");
  logger.info(`📱 Uninstalled ${pkg}`);
}

/** Start an app by package, letting Android resolve its launcher activity. */
export function launchApp(serial, pkg) {
  assertPackage(pkg);
  const r = adb(serial, ["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], { timeout: 15_000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (/No activities found|Error/i.test(out)) throw new Error("App has no launchable activity");
}

export function stopApp(serial, pkg) {
  assertPackage(pkg);
  adb(serial, ["shell", "am", "force-stop", pkg], { timeout: 15_000 });
}

/** Wipe app data — the fastest way back to a first-run state while testing. */
export function clearAppData(serial, pkg) {
  assertPackage(pkg);
  const r = adb(serial, ["shell", "pm", "clear", pkg], { timeout: 30_000 });
  if (!/Success/i.test(r.stdout || "")) throw new Error((r.stderr || r.stdout || "").trim().slice(0, 200) || "Clear failed");
}

/** Open a deep link — tests custom schemes without leaving the browser. */
export function openDeepLink(serial, url) {
  if (typeof url !== "string" || !url || url.length > 2000) throw new Error("Invalid URL");
  // adb argv, no shell — but reject control characters that would confuse am.
  if (/[\x00-\x1f]/.test(url)) throw new Error("Invalid URL");
  const r = adb(serial, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], { timeout: 15_000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (/Error:/i.test(out)) throw new Error(out.match(/Error:[^\n]+/)?.[0] || "Could not open link");
}

// KEYCODE_SLEEP / KEYCODE_WAKEUP. Not scrcpy's SET_DISPLAY_POWER: that one is
// undone when the session closes (Controller.setRestoreDisplayPower), which is
// exactly when we want the device to stay asleep.
const KEYCODE_SLEEP = 223;
const KEYCODE_WAKEUP = 224;

/** Blank the screen. Fire-and-forget: a failure here must not fail a teardown. */
export function sleepDevice(serial) {
  const bin = findAdb();
  if (!bin) return;
  execFile(bin, ["-s", serial, "shell", "input", "keyevent", String(KEYCODE_SLEEP)], () => {});
}

/** Wake before streaming, so the first frame is not of a black screen. */
export async function wakeDevice(serial) {
  const bin = findAdb();
  if (!bin) return;
  try {
    await execFileAsync(bin, ["-s", serial, "shell", "input", "keyevent", String(KEYCODE_WAKEUP)], { timeout: 5000 });
  } catch { /* the stream still works on a device that refused to wake */ }
}

/** 0=portrait, 1=landscape, 2=portrait-flipped, 3=landscape-flipped. */
export function setRotation(serial, rotation) {
  if (![0, 1, 2, 3].includes(rotation)) throw new Error("Invalid rotation");
  // accelerometer_rotation must be off or the system overrides user_rotation.
  adb(serial, ["shell", "settings", "put", "system", "accelerometer_rotation", "0"], { timeout: 8000 });
  adb(serial, ["shell", "settings", "put", "system", "user_rotation", String(rotation)], { timeout: 8000 });
}

export function getRotation(serial) {
  const r = adb(serial, ["shell", "settings", "get", "system", "user_rotation"], { timeout: 8000 });
  const n = Number(r.stdout?.trim());
  return [0, 1, 2, 3].includes(n) ? n : 0;
}

export function screenshot(serial) {
  const bin = findAdb();
  if (!bin) throw new Error("adb not found");
  const r = spawnSync(bin, ["-s", serial, "exec-out", "screencap", "-p"], {
    encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024
  });
  if (r.status !== 0 || !r.stdout?.length) throw new Error("Screenshot failed");
  return r.stdout;
}

// ─── APK staging ────────────────────────────────────────────────────────────

/** Directory uploaded APKs land in before install. Created on demand. */
export function stageDir() {
  const dir = path.join(os.tmpdir(), APK_STAGE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A staged path for `name`, with the basename stripped of any directory parts. */
export function stagePathFor(name) {
  const base = path.basename(String(name || "app.apk")).replace(/[^\w.\-]/g, "_");
  if (!base.toLowerCase().endsWith(".apk")) throw new Error("Only .apk files can be installed");
  return path.join(stageDir(), `${Date.now()}-${base}`);
}

export function assertApkSize(size) {
  if (!Number.isFinite(size) || size <= 0) throw new Error("Invalid size");
  if (size > APK_MAX_BYTES) throw new Error(`APK too large (max ${Math.round(APK_MAX_BYTES / 1024 / 1024)}MB)`);
}

export function cleanupStaged(filePath) {
  if (!filePath?.startsWith(stageDir())) return;
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}
