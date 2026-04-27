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
import { PATHS as APP_PATHS } from "../../lib/constants.js";

const AUTOSTART_LOG = join(APP_PATHS.LOGS, "autostart.log");

const APP_ID = "cc.9remote.agent";
const APP_NAME = "9Remote";
const AUTOSTART_ARGS = ["--tray", "--skip-update", "--start"];

const HOME = os.homedir();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PATHS = {
  darwin: join(HOME, "Library", "LaunchAgents", `${APP_ID}.plist`),
  linux: join(HOME, ".config", "autostart", `${APP_ID}.desktop`),
  linuxSystemd: join(HOME, ".config", "systemd", "user", `${APP_ID}.service`),
};

// Headless (VPS/SSH) detection — no GUI session means .desktop autostart never fires
function isHeadlessLinux() {
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

// Resolve CLI entry by walking up from __dirname to find 9remote package.json, then read its bin
function getCliEntry() {
  for (let dir = __dirname, prev = null; dir !== prev; prev = dir, dir = path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name !== "9remote") continue;
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["9remote"];
      if (bin) {
        const resolved = path.resolve(dir, bin);
        if (existsSync(resolved)) return resolved;
      }
    } catch {}
    break;
  }
  return path.resolve(__dirname, "..", "index.js");
}

function getNodeBin() {
  return process.execPath;
}

// Build PATH env covering system + node bin dir so child spawns (cloudflared, node) work under launchd
function getLaunchPath() {
  const nodeDir = path.dirname(getNodeBin());
  const base = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin"];
  if (!base.includes(nodeDir)) base.unshift(nodeDir);
  return base.join(":");
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
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(getLaunchPath())}</string>
        <key>HOME</key>
        <string>${escapeXml(HOME)}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${AUTOSTART_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${AUTOSTART_LOG}</string>
</dict>
</plist>
`;
}

function enableMac() {
  mkdirSync(path.dirname(PATHS.darwin), { recursive: true });
  writeFileSync(PATHS.darwin, buildPlist(getNodeBin(), getCliEntry()));
  // Do not bootstrap here: agent already running, plist takes effect at next login (avoid port collision)
  return true;
}

function disableMac() {
  // Only remove plist; don't bootout — that would kill the currently running agent (us)
  if (existsSync(PATHS.darwin)) {
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

function buildSystemdUnit() {
  const args = AUTOSTART_ARGS.map((a) => `'${a}'`).join(" ");
  return `[Unit]
Description=${APP_NAME} Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${getNodeBin()} ${getCliEntry()} ${args}
Restart=always
RestartSec=10
Environment=PATH=${getLaunchPath()}
Environment=HOME=${HOME}
StandardOutput=append:${AUTOSTART_LOG}
StandardError=append:${AUTOSTART_LOG}

[Install]
WantedBy=default.target
`;
}

function systemctlUser(args) {
  try {
    execFileSync("systemctl", ["--user", ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function enableLinux() {
  if (isHeadlessLinux()) {
    mkdirSync(path.dirname(PATHS.linuxSystemd), { recursive: true });
    writeFileSync(PATHS.linuxSystemd, buildSystemdUnit());
    systemctlUser(["daemon-reload"]);
    systemctlUser(["enable", `${APP_ID}.service`]);
    return true;
  }
  mkdirSync(path.dirname(PATHS.linux), { recursive: true });
  writeFileSync(PATHS.linux, buildDesktopFile());
  return true;
}

function disableLinux() {
  if (existsSync(PATHS.linuxSystemd)) {
    systemctlUser(["disable", `${APP_ID}.service`]);
    try { unlinkSync(PATHS.linuxSystemd); } catch {}
    systemctlUser(["daemon-reload"]);
  }
  if (existsSync(PATHS.linux)) {
    try { unlinkSync(PATHS.linux); } catch {}
  }
  return true;
}

function isEnabledLinux() {
  return existsSync(PATHS.linux) || existsSync(PATHS.linuxSystemd);
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
