// Download + install Android SDK components the host is missing, on an explicit
// user click from the UI. One download at a time; progress is pushed to the
// client, which may close and reopen freely — the job lives on the agent.

import { spawn, spawnSync, execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { SDK_SETUP, JDK_SETUP } from "./constants.js";
import { createLogger } from "../../lib/logger.js";
import { findAdb, resetAdbCache } from "./adb.js";
import { resetEmulatorCache, findEmulator, listAvds } from "./emulator.js";

const execFileAsync = promisify(execFile);

const logger = createLogger("mobile");

// The install target: the first SDK root the probes already look at, so a
// freshly installed component is found without any reconfiguration.
export function installRoot() {
  const home = os.homedir();
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, "Library/Android/sdk"),
    path.join(home, "Android/Sdk"),
    path.join(home, "AppData/Local/Android/Sdk")
  ].filter(Boolean);
  return roots[0];
}

// ── Job state ────────────────────────────────────────────────────────────────
// One download at a time: two unzips racing into the same SDK root would fight.

let job = null;   // { component, phase, received, total, bytesPerSec, error }
let cancelled = false;
// Every connected client gets progress pushes, so listeners are a set — a
// single slot would let a second connection silence the first.
const jobListeners = new Set();

export function sdkJobState() {
  return job ? { ...job } : null;
}

// Registers a listener and returns its disposer — a disconnect must remove
// exactly its own listener, not just the latest one.
export function setJobListener(fn) {
  if (typeof fn !== "function") return () => {};
  jobListeners.add(fn);
  return () => jobListeners.delete(fn);
}

function setJob(patch) {
  job = { ...job, ...patch };
  for (const fn of [...jobListeners]) {
    try { fn(); } catch { jobListeners.delete(fn); }
  }
}

export function isBusy() {
  return Boolean(job && job.phase !== "done" && job.phase !== "error");
}

// Image installs ride the same job slot as component downloads; the socket
// layer owns the lifecycle for those (percent-based, no byte counter).
export function beginJob(component, extra = {}) {
  if (isBusy()) throw new Error("Another download is already running");
  cancelled = false;
  job = { component, phase: "downloading", received: 0, total: 0, bytesPerSec: 0, error: null, ...extra };
  setJob({});
}

export function endJob(patch) {
  setJob(patch);
}

export function setCancelled(v) {
  cancelled = v;
}

// ── Disk space ───────────────────────────────────────────────────────────────
// Async + cached: mobile:list runs on the UI's poll, and a sync df there would
// block the event loop every few seconds. Unknown space is reported as null and
// never blocks — the UI just hides the number.

let cachedDiskFree;
let diskFreeAt = 0;

async function diskFreeBytes(dirPath) {
  if (Date.now() - diskFreeAt < SDK_SETUP.reprobeMs && cachedDiskFree !== undefined) return cachedDiskFree;
  diskFreeAt = Date.now();
  try {
    const { stdout } = await execFileAsync("df", ["-k", dirPath], { timeout: 3000 });
    const line = stdout.split("\n")[1];
    const avail = line && Number(line.trim().split(/\s+/)[3]);
    cachedDiskFree = Number.isFinite(avail) ? avail * 1024 : null;
  } catch {
    cachedDiskFree = null;
  }
  return cachedDiskFree;
}

// Install order the UI must respect: sdkmanager (inside cmdline-tools) is a
// Java tool, so the emulator branch of the catalog cannot run until both of
// these are in place. Everything else installs independently.
const COMPONENT_DEPENDENCIES = {
  "platform-tools": [],
  "cmdline-tools": [],
  "emulator": ["cmdline-tools", "jdk"],
  "jdk": []
};

export async function envStatus() {
  const components = {
    "platform-tools": { installed: Boolean(findAdb()) },
    "cmdline-tools": { installed: Boolean(sdkManagerPath()) },
    "emulator": { installed: Boolean(findEmulator()) },
    "jdk": { installed: Boolean(findJava()) }
  };
  // Carry the missing prerequisites on each row so the client can disable the
  // button and say why, instead of letting the user hit a dead error.
  for (const [name, comp] of Object.entries(components)) {
    comp.requires = COMPONENT_DEPENDENCIES[name] || [];
    comp.missingRequires = comp.requires.filter((r) => !components[r]?.installed);
  }
  return {
    installRoot: installRoot(),
    diskFree: await diskFreeBytes(installRoot()),
    busy: isBusy(),
    job: sdkJobState(),
    components
  };
}

// ── Java ─────────────────────────────────────────────────────────────────────
// sdkmanager/avdmanager are Java tools; without a JDK 17+ they cannot run. The
// check is cheap and cached like the other probes.

let cachedJava;
let javaProbedAt = 0;

export function findJava() {
  if (cachedJava !== undefined && (cachedJava || Date.now() - javaProbedAt < SDK_SETUP.reprobeMs)) return cachedJava;
  javaProbedAt = Date.now();
  cachedJava = detectJava() || null;
  return cachedJava;
}

function detectJava() {
  // A JDK we installed ourselves lives under the SDK root.
  const bundled = path.join(installRoot(), JDK_SETUP.dirName);
  const bundledHome = fs.existsSync(bundled)
    ? (process.platform === "darwin" ? path.join(bundled, "Contents", "Home") : bundled)
    : null;
  if (bundledHome && fs.existsSync(path.join(bundledHome, "bin", process.platform === "win32" ? "java.exe" : "java"))) {
    return bundledHome;
  }
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  // macOS answers without spawning java; elsewhere the version check decides.
  if (process.platform === "darwin") {
    try {
      const r = spawnSync("/usr/libexec/java_home", ["-v", `${JDK_SETUP.version}+`], { encoding: "utf8" });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch { /* fall through */ }
  }
  const probe = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (probe.status === 0) return "java";   // on PATH; version adequacy assumed
  return null;
}

function resetJavaCache() {
  cachedJava = undefined;
  javaProbedAt = 0;
}

// ── sdkmanager / avdmanager ──────────────────────────────────────────────────

export function sdkManagerPath() {
  const root = installRoot();
  const exe = process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager";
  // Latest-first: an upgraded layout may hold several versions side by side.
  const base = path.join(root, "cmdline-tools");
  try {
    const versions = fs.readdirSync(base)
      .filter((d) => fs.existsSync(path.join(base, d, "bin", exe)))
      .sort()
      .reverse();
    return versions.length ? path.join(base, versions[0], "bin", exe) : null;
  } catch {
    return null;
  }
}

export function avdManagerPath() {
  const sdk = sdkManagerPath();
  if (!sdk) return null;
  return path.join(path.dirname(path.dirname(sdk)), "bin", process.platform === "win32" ? "avdmanager.bat" : "avdmanager");
}

// Every sdkmanager/avdmanager invocation needs JAVA_HOME pointing at 17+.
function javaEnv() {
  const home = findJava();
  return home && home !== "java" ? { ...process.env, JAVA_HOME: home } : process.env;
}

// Runs a cmdline-tools binary, capturing stderr (sdkmanager writes progress
// there). Throws on non-zero exit with the tail of the output.
async function runTool(toolPath, args, { onStdout, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(toolPath, args, {
      env: javaEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs ? setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`${path.basename(toolPath)} timed out`));
    }, timeoutMs) : null;
    child.stdout.on("data", (d) => {
      stdout += d;
      onStdout?.(d.toString());
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(toolPath)} exited ${code}: ${(stderr || stdout).trim().slice(-400)}`));
    });
  });
}

// ── Download ─────────────────────────────────────────────────────────────────
// Redirects are followed by hand so the progress counter can stay on one socket
// and a cancel can simply destroy it.

function download(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const req = https.get(url, { headers: { "User-Agent": "9remote" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, destPath, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        finish(reject, new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers["content-length"]) || 0;
      let received = 0;
      let lastTick = Date.now();
      let lastReceived = 0;
      const out = fs.createWriteStream(destPath);
      res.on("data", (chunk) => {
        received += chunk.length;
        if (cancelled) { req.destroy(); out.destroy(); finish(reject, new Error("cancelled")); return; }
        const now = Date.now();
        if (now - lastTick >= 500) {
          onProgress(received, total, bytesPerSec(received, lastReceived, lastTick, now));
          lastTick = now;
          lastReceived = received;
        }
      });
      out.on("error", (e) => finish(reject, e));
      res.pipe(out);
      out.on("finish", () => finish(resolve));
    });
    req.on("error", (e) => finish(reject, cancelled ? new Error("cancelled") : e));
    req.setTimeout(SDK_SETUP.downloadTimeoutMs, () => req.destroy(new Error("Download timed out")));
  });
}

function bytesPerSec(received, lastReceived, lastTick, now) {
  return Math.round((received - lastReceived) * 1000 / Math.max(1, now - lastTick));
}

// ── Extract ──────────────────────────────────────────────────────────────────

function unzip(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    // macOS and Linux ship unzip; Windows 10+ ships tar, which handles zip.
    const exe = process.platform === "win32" ? "tar" : "unzip";
    const args = process.platform === "win32"
      ? ["-xf", archivePath, "-C", destDir]
      : ["-q", archivePath, "-d", destDir];
    const child = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip failed (${code}): ${stderr.trim().slice(0, 300)}`));
    });
  });
}

// ── Install ──────────────────────────────────────────────────────────────────

export async function installComponent(name) {
  if (isBusy()) throw new Error("Another download is already running");
  // Server-side mirror of what the UI disables: a crafted client must not
  // reach "cmdline-tools not installed" mid-download after a 150MB wait.
  const missingDeps = (COMPONENT_DEPENDENCIES[name] || []).filter((dep) => {
    if (dep === "jdk") return !findJava();
    if (dep === "cmdline-tools") return !sdkManagerPath();
    return false;
  });
  if (missingDeps.length) throw new Error(`Requires ${missingDeps.join(", ")} first`);
  if (name === "jdk") return installJdk();
  // The emulator has no stable direct zip; it is distributed through
  // sdkmanager like the system images.
  if (name === "emulator") {
    beginJob("emulator", { kind: "image" });
    try {
      const result = await installEmulatorPackage((pct) => endJob({ percent: pct }));
      endJob({ phase: "done" });
      return result;
    } catch (err) {
      endJob({ phase: "error", error: err.message });
      throw err;
    }
  }
  const spec = SDK_SETUP.components[name];
  if (!spec) throw new Error(`Unknown component: ${name}`);
  const url = spec.urls[process.platform];
  if (!url) throw new Error(`No download for ${process.platform}`);

  const root = installRoot();
  fs.mkdirSync(root, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-sdk-"));
  const archivePath = path.join(tmpDir, `${name}.zip`);
  cancelled = false;
  job = { component: name, phase: "downloading", received: 0, total: 0, bytesPerSec: 0, error: null };

  try {
    await download(url, archivePath, (received, total, bps) => setJob({ received, total, bytesPerSec: bps }));
    if (cancelled) throw new Error("cancelled");
    setJob({ phase: "extracting" });
    await unzip(archivePath, tmpDir);
    // The zip unpacks a single top folder (platform-tools/, cmdline-tools/),
    // which is nearly the SDK layout. cmdline-tools must land as
    // cmdline-tools/latest/ for sdkmanager to find itself; the rest is moved
    // as-is. A cross-volume rename fails with EXDEV, so a copy is the fallback.
    const target = path.join(root, name);
    fs.rmSync(target, { recursive: true, force: true });
    const extracted = path.join(tmpDir, name);
    if (name === "cmdline-tools") {
      fs.mkdirSync(target, { recursive: true });
      try {
        fs.renameSync(extracted, path.join(target, "latest"));
      } catch {
        fs.cpSync(extracted, path.join(target, "latest"), { recursive: true });
      }
    } else {
      try {
        fs.renameSync(extracted, target);
      } catch {
        fs.cpSync(extracted, target, { recursive: true });
      }
    }

    // Re-probe so the new binary is visible immediately, no agent restart.
    resetAdbCache();
    resetEmulatorCache();
    resetJavaCache();

    setJob({ phase: "done" });
    logger.info(`📦 SDK component installed: ${name} → ${root}`);
    return { installed: name, root };
  } catch (err) {
    // The client renders the failure against the component row that started it.
    setJob({ phase: "error", error: err.message });
    throw err;
  } finally {
    // The tmp dir holds either nothing of value (moved) or a cancelled/partial
    // download — removed either way.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// The JDK zip (mac: .tar.gz via the Adoptium API) unpacks a versioned folder
// like jdk-17.0.12+7 — standardised into JDK_SETUP.dirName so findJava can
// rely on the path. macOS JDKs carry Contents/Home inside.
async function installJdk() {
  if (isBusy()) throw new Error("Another download is already running");
  const arch = process.platform === "darwin" && process.arch === "arm64" ? "darwinArm64" : process.platform;
  const url = JDK_SETUP.urls[arch];
  if (!url) throw new Error(`No JDK download for ${process.platform}/${process.arch}`);
  const isTar = process.platform === "darwin" || process.platform === "linux";
  const ext = isTar ? "tar.gz" : "zip";

  const root = installRoot();
  fs.mkdirSync(root, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-jdk-"));
  const archivePath = path.join(tmpDir, `jdk.${ext}`);
  cancelled = false;
  job = { component: "jdk", phase: "downloading", received: 0, total: 0, bytesPerSec: 0, error: null };

  try {
    await download(url, archivePath, (received, total, bps) => setJob({ received, total, bytesPerSec: bps }));
    if (cancelled) throw new Error("cancelled");
    setJob({ phase: "extracting" });
    await (isTar ? untar(archivePath, tmpDir) : unzip(archivePath, tmpDir));
    const entries = fs.readdirSync(tmpDir).filter((e) => e.startsWith("jdk-"));
    const extracted = entries[0];
    if (!extracted) throw new Error("JDK archive layout unexpected");
    const target = path.join(root, JDK_SETUP.dirName);
    fs.rmSync(target, { recursive: true, force: true });
    try {
      fs.renameSync(path.join(tmpDir, extracted), target);
    } catch {
      fs.cpSync(path.join(tmpDir, extracted), target, { recursive: true });
    }

    resetJavaCache();

    setJob({ phase: "done" });
    logger.info(`📦 JDK ${JDK_SETUP.version} installed → ${target}`);
    return { installed: "jdk", root };
  } catch (err) {
    setJob({ phase: "error", error: err.message });
    throw err;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function untar(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (${code}): ${stderr.trim().slice(0, 300)}`));
    });
  });
}

export function cancelInstall() {
  if (!isBusy()) return false;
  cancelled = true;
  return true;
}

// ── One-tap provisioning ─────────────────────────────────────────────────────
// The UI offers devices, not SDK packages: the user picks "Pixel 7" and this
// side works out the profile, the image, and every missing tool in order.

// Two presets, deliberately generic profiles: medium_phone/tablet ask for
// 800MB of data partition, while named-device profiles (pixel_7: 6GB) make
// the emulator refuse to boot on a disk with under ~7.3GB free.
const PROVISION_PRESETS = [
  { id: "phone", label: "Phone", profileId: "medium_phone", api: 36 },
  { id: "tablet", label: "Tablet", profileId: "medium_tablet", api: 36 }
];

// Presets store the API level only; the package path is derived from the host
// ABI at use time. Building it in one place keeps the list and the provision
// run from drifting apart.
function presetImagePath(preset) {
  return `system-images;android-${preset.api};google_apis;${hostAbi()}`;
}

export function listProvisionPresets() {
  return PROVISION_PRESETS.map((p) => {
    const imagePath = presetImagePath(p);
    const needsImage = !listInstalledImages().includes(imagePath);
    return {
      ...p,
      imagePath,
      // What the tap will cost: "ready" when everything is already on disk,
      // otherwise the ~1.5GB image download is the honest number to show.
      ready: !needsImage && Boolean(findAdb() && sdkManagerPath() && findJava() && findEmulator())
    };
  });
}

// Sequential self-setup then AVD creation. Each step manages the shared job
// slot itself (installComponent/installImage already do), so this only
// orchestrates and stamps the step name for the client.
export async function provisionPreset(presetId, { onStep } = {}) {
  const preset = PROVISION_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`Unknown device: ${presetId}`);
  if (isBusy()) throw new Error("A setup is already running");

  // Fail fast with real numbers: the emulator's own error surfaces only at
  // boot, far from the tap that caused it.
  const free = await diskFreeBytes(avdHome());
  if (free != null && free < SDK_SETUP.minDiskBytes) {
    throw new Error(`Not enough disk space — a new device needs ~7.3 GB free, only ${(free / 1024 ** 3).toFixed(1)} GB available`);
  }

  const step = async (label, fn) => {
    onStep?.(label);
    await fn();
  };

  try {
    if (!findAdb()) await step("platform-tools", () => installComponent("platform-tools"));
    if (!findJava()) await step("jdk", () => installComponent("jdk"));
    if (!sdkManagerPath()) await step("cmdline-tools", () => installComponent("cmdline-tools"));
    if (!findEmulator()) await step("emulator", () => installComponent("emulator"));

    const imagePath = presetImagePath(preset);
    if (!listInstalledImages().includes(imagePath)) {
      await step("image", () => installImage(imagePath, (pct) => endJob({ percent: pct })));
    }

    // Auto-name: 9r_phone, 9r_phone_2, … — the user never types one.
    const existing = await listAvds();
    let n = 1;
    let name = `9r_${preset.id}`;
    while (existing.includes(name)) {
      n += 1;
      name = `9r_${preset.id}_${n}`;
    }

    await step("create", () => createAvd({ name, imagePath, deviceId: preset.profileId }));
    endJob({ phase: "done" });
    logger.info(`📱 Provisioned ${name} (${imagePath})`);
    return { avdName: name };
  } catch (err) {
    // The install steps stamp their own error onto the job; this catch covers
    // the ones that do not (naming, create) — without it the shared job slot
    // stays "busy" and blocks every later install until an agent restart.
    endJob({ phase: "error", error: err.message });
    throw err;
  }
}

// ── AVD management (avdmanager) ──────────────────────────────────────────────

// Device profiles the create wizard offers. `avdmanager list device` answers
// the real catalog; this is only the default ordering when it cannot be read.
export async function listDeviceProfiles() {
  const avd = avdManagerPath();
  if (!avd) throw new Error("cmdline-tools not installed");
  const { stdout } = await runTool(avd, ["list", "device"], { timeoutMs: 30_000 });
  // Blocks look like:
  //   id: 0 or "pixel_7"
  //   Name: Pixel 7
  //   ...
  const profiles = [];
  let cur = null;
  for (const line of stdout.split("\n")) {
    const id = line.match(/^\s*id:\s*\d+\s+or\s+"([^"]+)"/);
    if (id) { cur = { id: id[1], name: id[1] }; continue; }
    const name = line.match(/^\s*Name:\s*(.+)$/);
    if (name && cur) cur.name = name[1].trim();
    if (cur && cur.id && cur.name !== cur.id && !profiles.find((p) => p.id === cur.id)) {
      profiles.push({ ...cur });
      cur = { ...cur };
    }
  }
  return profiles;
}

export async function createAvd({ name, imagePath, deviceId }) {
  const avd = avdManagerPath();
  if (!avd) throw new Error("cmdline-tools not installed");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name || "")) throw new Error("Invalid AVD name");
  if (!/^[\w.;-]+$/.test(imagePath || "")) throw new Error("Invalid package path");
  if (deviceId && !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) throw new Error("Invalid device id");
  const args = ["create", "avd", "-n", name, "-k", imagePath];
  if (deviceId) args.push("-d", deviceId);
  // create avd asks "Do you wish to create a custom hardware profile?" — no.
  await runToolCancelable(avd, args, { stdinput: "no\n" }).done;
  return { created: name };
}

// Only AVDs that are powered off may be deleted or wiped — the .lock files an
// emulator holds would otherwise make both fail or corrupt the image.
function avdHome() {
  return process.env.ANDROID_AVD_HOME || process.env.ANDROID_SDK_HOME
    ? path.join(process.env.ANDROID_AVD_HOME || process.env.ANDROID_SDK_HOME, ".android", "avd")
    : path.join(os.homedir(), ".android", "avd");
}

function avdPaths(avdName) {
  const home = avdHome();
  const ini = path.join(home, `${avdName}.ini`);
  const dir = path.join(home, `${avdName}.avd`);
  return { ini, dir };
}

export async function deleteAvd(avdName) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(avdName || "")) throw new Error("Invalid AVD name");
  const { ini, dir } = avdPaths(avdName);
  let removed = false;
  try { fs.rmSync(ini, { force: true }); removed = true; } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  logger.info(`🗑️ AVD deleted: ${avdName}`);
  return { removed };
}

export async function wipeAvdData(avdName) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(avdName || "")) throw new Error("Invalid AVD name");
  const { dir } = avdPaths(avdName);
  // The userdata images carry everything a wipe should clear; keep hardware
  // config (config.ini, snapshots dir is gone after next boot anyway).
  const targets = ["userdata-qemu.img", "userdata.img", "cache.img", "snapshots"];
  let wiped = false;
  for (const t of targets) {
    try { fs.rmSync(path.join(dir, t), { recursive: true, force: true }); wiped = true; } catch {}
  }
  logger.info(`🧹 AVD data wiped: ${avdName}`);
  return { wiped };
}

// sdkmanager progress looks like "[====    ] 12% Fetch remote repository..." —
// the percent sits AFTER the bracket, and lines arrive as \r-separated runs.
function extractPercent(line) {
  const matches = [...line.matchAll(/(\d+)%/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

export async function listImages() {
  const sdk = sdkManagerPath();
  if (!sdk) throw new Error("cmdline-tools not installed");
  const { stdout } = await runTool(sdk, ["--list"], { timeoutMs: 60_000 });
  // Package lines look like:
  //   system-images;android-35;google_apis;arm64-v8a | 5 | ...
  const images = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(system-images;[\w.;-]+)\s+\|\s*(\d+)\s*\|/);
    if (m) images.push({ path: m[1], version: m[2] });
  }
  return images;
}

// The host's CPU architecture narrows the catalog: an arm64-v8a image cannot
// run under an x86_64 emulator and vice versa.
export function hostAbi() {
  return ["arm64", "aarch64"].includes(process.arch) ? "arm64-v8a" : "x86_64";
}

// Installed images read straight off disk — sdkmanager's --list output mixes
// them into the catalog, and a directory listing answers in microseconds.
export function listInstalledImages() {
  const base = path.join(installRoot(), "system-images");
  const out = [];
  // system-images/<api>/<variant>/<abi>/ holds the payload; a directory
  // containing system.img terminates a path, anything else recurses.
  const walk = (dir, parts) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const seg = path.join(dir, e.name);
      const next = [...parts, e.name];
      if (fs.existsSync(path.join(seg, "system.img")) || fs.existsSync(path.join(seg, "system.img.qcow2"))) {
        out.push(`system-images;${next.join(";")}`);
      } else {
        walk(seg, next);
      }
    }
  };
  walk(base, []);
  return out;
}

export async function installEmulatorPackage(onProgress) {
  const sdk = sdkManagerPath();
  if (!sdk) throw new Error("cmdline-tools not installed");
  // A cancel must reach the java process itself — sdkmanager ignores flags and
  // would happily download gigabytes after one.
  const childPromise = runToolCancelable(sdk, ["--install", "emulator"], {
    onStdout: (chunk) => {
      for (const line of chunk.split(/[\r\n]+/)) {
        const pct = extractPercent(line);
        if (pct != null) onProgress?.(pct);
      }
    }
  });
  const stopWatch = setInterval(() => {
    if (cancelled) childPromise.kill();
  }, 500);
  try {
    await childPromise.done;
    // The emulator binary lands under the SDK root; drop the cached null so
    // the next findEmulator() sees it.
    resetEmulatorCache();
    return { installed: "emulator" };
  } finally {
    clearInterval(stopWatch);
  }
}

export async function installImage(imagePath, onProgress) {
  const sdk = sdkManagerPath();
  if (!sdk) throw new Error("cmdline-tools not installed");
  // `|| ""` matters: regex.test(undefined) coerces to the string "undefined"
  // and passes, sending a literal "undefined" package name to sdkmanager.
  if (!/^[\w.;-]+$/.test(imagePath || "")) throw new Error("Invalid package path");
  // sdkmanager refuses to install while licenses are unanswered; the user has
  // already confirmed the download, so accepting on their behalf here matches
  // what Android Studio's first wizard run does.
  try {
    await runToolCancelable(sdk, ["--licenses"], { stdinput: "y\n" });
  } catch { /* already accepted, or the probe failed — install will tell */ }
  // A cancel must reach the java process itself — sdkmanager ignores flags and
  // would happily download gigabytes after one.
  const childPromise = runToolCancelable(sdk, ["--install", imagePath], {
    onStdout: (chunk) => {
      for (const line of chunk.split(/[\r\n]+/)) {
        const pct = extractPercent(line);
        if (pct != null) onProgress?.(pct);
      }
    }
  });
  const stopWatch = setInterval(() => {
    if (cancelled) childPromise.kill();
  }, 500);
  try {
    return await childPromise.done;
  } finally {
    clearInterval(stopWatch);
  }
}

// runTool plus a handle to kill the child (a cancel has no other way in).
// stdinput feeds stdin up front (license prompts answer "y").
function runToolCancelable(toolPath, args, { onStdout, stdinput } = {}) {
  let kill = () => {};
  const done = new Promise((resolve, reject) => {
    const child = spawn(toolPath, args, { env: javaEnv(), stdio: ["pipe", "pipe", "pipe"] });
    if (stdinput) {
      child.stdin.write(stdinput.repeat(20));
      child.stdin.end();
    }
    kill = () => { try { child.kill("SIGKILL"); } catch {} reject(new Error("cancelled")); };
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      onStdout?.(d.toString());
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (cancelled) { reject(new Error("cancelled")); return; }
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(toolPath)} exited ${code}: ${(stderr || stdout).trim().slice(-400)}`));
    });
  });
  return { done, kill };
}

export async function uninstallImage(imagePath) {
  const sdk = sdkManagerPath();
  if (!sdk) throw new Error("cmdline-tools not installed");
  // Segments are validated per-part: ".." passes the earlier charset regex
  // and would walk the join out of the SDK root — a sibling directory like
  // "<root>2" even survives a plain startsWith(root) prefix check.
  const segments = String(imagePath || "").split(";");
  if (segments.length < 2 || segments.some((s) => !s || s === "." || s === ".." || !/^[\w-]+$/.test(s))) {
    throw new Error("Invalid package path");
  }
  // --uninstall asks for confirmation on stdin; --licenses style prompting is
  // bypassed by removing the package dir directly instead.
  const root = installRoot();
  const dir = path.join(root, ...segments);
  if (!dir.startsWith(root + path.sep)) throw new Error("Invalid package path");
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: imagePath };
}
