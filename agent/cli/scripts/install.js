#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SYSTRAY_PKG = "systray2";
const SYSTRAY_VERSION = "2.1.4";
const DATA_DIR = path.join(os.homedir(), ".9remote");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const RUNTIME_MODULES = path.join(RUNTIME_DIR, "node_modules");

function ensureRuntimeDir() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const pkgPath = path.join(RUNTIME_DIR, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "9remote-runtime", version: "1.0.0", private: true }, null, 2));
  }
}

function hasSystray2() {
  const binName = process.platform === "darwin" ? "tray_darwin_release" : "tray_linux_release";
  return fs.existsSync(path.join(RUNTIME_MODULES, SYSTRAY_PKG, "traybin", binName));
}

function chmodBin() {
  if (process.platform === "win32") return;
  const binName = process.platform === "darwin" ? "tray_darwin_release" : "tray_linux_release";
  const binPath = path.join(RUNTIME_MODULES, SYSTRAY_PKG, "traybin", binName);
  try { if (fs.existsSync(binPath)) fs.chmodSync(binPath, 0o755); } catch {}
}

function ensureTrayRuntime() {
  if (process.platform === "win32") return;
  ensureRuntimeDir();
  // Purge legacy systray v1 cache so we never resolve the old binary after update
  try { fs.rmSync(path.join(os.homedir(), ".cache", "node-systray"), { recursive: true, force: true }); } catch {}
  if (hasSystray2()) { chmodBin(); return; }

  console.log("⏳ Installing system tray (first run)...");
  const res = spawnSync("npm", ["install", `${SYSTRAY_PKG}@${SYSTRAY_VERSION}`, "--no-save"], {
    cwd: RUNTIME_DIR, stdio: "inherit", timeout: 120000,
    shell: process.platform === "win32"
  });
  if (res.status === 0) { chmodBin(); console.log("✅ System tray ready"); }
  else console.warn("⚠️  System tray install failed — tray disabled");
}

function checkRobotjs() {
  try {
    require.resolve("@hurdlegroup/robotjs");
    console.log("✅ robotjs installed (Remote desktop available)");
  } catch {
    console.log("ℹ️  robotjs not available (Remote desktop disabled)");
  }
}

try { checkRobotjs(); } catch {}
try { ensureTrayRuntime(); } catch {}
process.exit(0);
