#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_SRC = path.join(ROOT, "agent", "dist");

if (!fs.existsSync(DIST_SRC)) {
  console.error("❌ agent/dist not found. Run npm run agent:build first.");
  process.exit(1);
}

// 1. Discover all targets where Tauri desktop looks for cli.cjs
const home = os.homedir();
const targets = new Set();

// Private prefix paths (~/.9remote/npm)
const privateLib = path.join(home, ".9remote", "npm", "lib", "node_modules", "9remote");
const privateRoot = path.join(home, ".9remote", "npm", "node_modules", "9remote");

if (fs.existsSync(privateLib)) targets.add(privateLib);
if (fs.existsSync(privateRoot)) targets.add(privateRoot);

// Global npm path (npm root -g)
try {
  const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
  const globalPkg = path.join(globalRoot, "9remote");
  if (fs.existsSync(globalPkg)) targets.add(globalPkg);
} catch {}

// Ensure ~/.9remote/npm/node_modules symlink exists on macOS/Linux if lib exists
if (process.platform !== "win32" && fs.existsSync(path.join(home, ".9remote", "npm", "lib", "node_modules"))) {
  const rootNm = path.join(home, ".9remote", "npm", "node_modules");
  if (!fs.existsSync(rootNm)) {
    try {
      fs.symlinkSync("lib/node_modules", rootNm, "dir");
    } catch {}
  }
}

// 3. Sync dist into all detected target locations
for (const targetPkg of targets) {
  const targetDist = path.join(targetPkg, "dist");
  try {
    fs.cpSync(DIST_SRC, targetDist, { recursive: true, force: true });
    console.log(`✅ Synced agent/dist → ${targetDist}`);
  } catch (err) {
    console.warn(`⚠️ Could not sync to ${targetDist}: ${err.message}`);
  }
}

// 4. Optionally kill running ptyDaemon only if explicitly requested (--kill-daemon)
// Default keeps daemon running so live terminal / agent sessions are not lost during dev sync.
if (process.argv.includes("--kill-daemon")) {
  const pidFile = path.join(home, ".9remote", "pids", "ptyDaemon.pid");
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid, "SIGTERM");
        console.log(`✅ Stopped running ptyDaemon (PID: ${pid})`);
      }
    }
  } catch {}
}

