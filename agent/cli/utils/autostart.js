/**
 * Cross-platform OS auto-start (run on user login).
 * macOS  → LaunchAgent plist
 * Win    → HKCU Run registry key
 * Linux  → ~/.config/autostart/*.desktop
 */

import { execFile, execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const APP_ID = "cc.9remote.agent";
const APP_NAME = "9Remote";
const AUTOSTART_ARGS = ["--tray", "--skip-update", "--start"];

const HOME = os.homedir();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PATHS = {
  darwin: join(HOME, "Library", "LaunchAgents", `${APP_ID}.plist`),
  linux: join(HOME, ".config", "autostart", `${APP_ID}.desktop`),
};

// Resolve CLI entry: bundled cli.cjs (prod) → index.js (dev)
function getCliEntry() {
  const bundled = path.resolve(__dirname, "..", "..", "dist", "cli.cjs");
  if (existsSync(bundled)) return bundled;
  return path.resolve(__dirname, "..", "index.js");
}

function getNodeBin() {
  return process.execPath;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── macOS ─────────────────────────────────────────────────────────────────────

function buildPlist(node, script) {
  const args = [node, script, ...AUTOSTART_ARGS]
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${APP_ID}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${join(HOME, ".9remote", "autostart.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(HOME, ".9remote", "autostart.log")}</string>
</dict>
</plist>
`;
}

function enableMac() {
  mkdirSync(path.dirname(PATHS.darwin), { recursive: true });
  writeFileSync(PATHS.darwin, buildPlist(getNodeBin(), getCliEntry()));
  // Best-effort load — silent fail (already loaded / not allowed)
  try { execFileSync("launchctl", ["unload", PATHS.darwin], { stdio: "ignore" }); } catch {}
  try { execFileSync("launchctl", ["load", PATHS.darwin], { stdio: "ignore" }); } catch {}
  return true;
}

function disableMac() {
  if (existsSync(PATHS.darwin)) {
    try { execFileSync("launchctl", ["unload", PATHS.darwin], { stdio: "ignore" }); } catch {}
    try { unlinkSync(PATHS.darwin); } catch {}
  }
  return true;
}

function isEnabledMac() {
  return existsSync(PATHS.darwin);
}

// ── Windows ───────────────────────────────────────────────────────────────────

function buildWinCommand() {
  // Quote node + script paths so spaces in path work
  return `"${getNodeBin()}" "${getCliEntry()}" ${AUTOSTART_ARGS.join(" ")}`;
}

function regRun(args) {
  return new Promise((resolve) => {
    execFile("reg", args, { windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || "" });
    });
  });
}

async function enableWin() {
  const cmd = buildWinCommand();
  const { ok } = await regRun([
    "ADD", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/V", APP_NAME, "/t", "REG_SZ", "/D", cmd, "/F",
  ]);
  return ok;
}

async function disableWin() {
  await regRun([
    "DELETE", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/V", APP_NAME, "/F",
  ]);
  return true;
}

async function isEnabledWin() {
  const { ok, stdout } = await regRun([
    "QUERY", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/V", APP_NAME,
  ]);
  return ok && stdout.includes(APP_NAME);
}

// ── Linux ─────────────────────────────────────────────────────────────────────

function buildDesktopFile() {
  const exec = `${getNodeBin()} ${getCliEntry()} ${AUTOSTART_ARGS.join(" ")}`;
  return `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Exec=${exec}
X-GNOME-Autostart-enabled=true
NoDisplay=false
Terminal=false
`;
}

function enableLinux() {
  mkdirSync(path.dirname(PATHS.linux), { recursive: true });
  writeFileSync(PATHS.linux, buildDesktopFile());
  return true;
}

function disableLinux() {
  if (existsSync(PATHS.linux)) {
    try { unlinkSync(PATHS.linux); } catch {}
  }
  return true;
}

function isEnabledLinux() {
  return existsSync(PATHS.linux);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function isAutoStartEnabled() {
  try {
    if (process.platform === "darwin") return isEnabledMac();
    if (process.platform === "win32") return await isEnabledWin();
    if (process.platform === "linux") return isEnabledLinux();
  } catch {}
  return false;
}

export async function setAutoStart(enabled) {
  try {
    if (process.platform === "darwin") return enabled ? enableMac() : disableMac();
    if (process.platform === "win32") return enabled ? await enableWin() : await disableWin();
    if (process.platform === "linux") return enabled ? enableLinux() : disableLinux();
  } catch {}
  return false;
}
