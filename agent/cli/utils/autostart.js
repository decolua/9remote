/**
 * Cross-platform OS auto-start (run on user login).
 * macOS  → LaunchAgent plist
 * Win    → Startup-folder VBS (WshShell.Run ..., 0, False → invisible, no console flash)
 * Linux  → ~/.config/autostart/*.desktop
 */

import { execFile, execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { PATHS as APP_PATHS, PACKAGE_NAME } from "../../lib/constants.js";

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
  // Windows Startup folder VBS — WshShell.Run(..., 0, False) launches node invisibly, no console flash
  win: join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${APP_NAME}.vbs`),
};

// Headless (VPS/SSH) detection — no GUI session means .desktop autostart never fires
function isHeadlessLinux() {
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

// Resolve CLI entry by walking up from __dirname to find 9remote package.json, then read its bin
export function getCliEntry() {
  for (let dir = __dirname, prev = null; dir !== prev; prev = dir, dir = path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name !== PACKAGE_NAME) continue;
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[PACKAGE_NAME];
      if (bin) {
        const resolved = path.resolve(dir, bin);
        if (existsSync(resolved)) return resolved;
      }
    } catch {}
    break;
  }
  // Fallback: the actual entry file this process was launched with
  return process.argv[1] || path.resolve(__dirname, "..", "index.js");
}

export function getNodeBin() {
  return process.execPath;
}

// Under the Electron shell execPath is the app binary, so any script spawning it
// must set this flag or it relaunches the GUI instead of running the CLI.
export function nodeBinEnvPrefix() {
  return process.versions.electron ? "env ELECTRON_RUN_AS_NODE=1 " : "";
}

/**
 * Spawn the agent fully detached and hidden (no console flash).
 * Windows: node.exe is a console app — even windowsHide flashes a window when
 * launched from a TTY. A VBScript .Run(..., 0, False) launches it with window
 * style 0 (invisible) and detached, so nothing flashes. Mac/Linux: plain detached spawn.
 * @param {string[]} args - CLI args (e.g. ["--tray", "--start"])
 * @returns {number|null} spawned pid (null on Windows — VBS is fire-and-forget)
 */
export function spawnHidden(args) {
  const nodeBin = getNodeBin();
  const cliEntry = getCliEntry();

  if (process.platform === "win32") {
    const argStr = args.join(" ");
    const vbsPath = join(os.tmpdir(), `${PACKAGE_NAME}-launch.vbs`);
    writeFileSync(
      vbsPath,
      `CreateObject("WScript.Shell").Run "\"\"${nodeBin}\"\" \"\"${cliEntry}\"\" ${argStr}", 0, False\n`
    );
    const child = execFile("wscript.exe", [vbsPath], { windowsHide: true });
    child.unref?.();
    return null;
  }

  const child = spawn(nodeBin, [cliEntry, ...args], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid || null;
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

// Startup-folder VBS instead of HKCU\Run registry key: registry runs node.exe
// (a console app) directly, flashing a cmd window at login. The VBS calls
// WshShell.Run(cmd, 0, False) — window style 0 (invisible), detached — so
// nothing flashes. Same login trigger, invisible launch.
function buildWinVbs() {
  const argStr = AUTOSTART_ARGS.join(" ");
  return `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${getNodeBin()}"" ""${getCliEntry()}"" ${argStr}", 0, False
`;
}

// Remove legacy HKCU\Run entry from when autostart used the registry key
// instead of the Startup-folder VBS. Left behind, it spawns node.exe directly
// (console flash at login) and races the VBS — clean on every enable/disable.
function cleanLegacyWinRun() {
  try {
    execFileSync("reg", [
      "DELETE", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/V", APP_NAME, "/F",
    ], { windowsHide: true, stdio: "ignore" });
  } catch {}
}

function enableWin() {
  const dir = path.dirname(PATHS.win);
  if (!existsSync(dir)) return false;
  cleanLegacyWinRun();
  writeFileSync(PATHS.win, buildWinVbs());
  return true;
}

function disableWin() {
  cleanLegacyWinRun();
  if (existsSync(PATHS.win)) {
    try { unlinkSync(PATHS.win); } catch {}
  }
  return true;
}

function isEnabledWin() {
  return existsSync(PATHS.win);
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

// Rewrite existing autostart entry ONLY if enabled and content drifted (path/args changed after update).
// No-op when disabled or already up-to-date — avoids rewriting on every boot.
export async function refreshAutoStart() {
  try {
    // Always clean legacy registry entry on Windows — even if autostart is
    // disabled, a stale HKCU\Run from before the VBS migration still flashes
    // a console at login. No-op once gone.
    if (process.platform === "win32") cleanLegacyWinRun();

    if (!(await isAutoStartEnabled())) return false;

    if (process.platform === "darwin") {
      const desired = buildPlist(getNodeBin(), getCliEntry());
      const current = existsSync(PATHS.darwin) ? readFileSync(PATHS.darwin, "utf8") : "";
      if (current === desired) return false;
      writeFileSync(PATHS.darwin, desired);
      return true;
    }

    if (process.platform === "win32") {
      const desired = buildWinVbs();
      const current = existsSync(PATHS.win) ? readFileSync(PATHS.win, "utf8") : "";
      if (current === desired) return false;
      writeFileSync(PATHS.win, desired);
      return true;
    }

    if (process.platform === "linux") {
      if (existsSync(PATHS.linuxSystemd)) {
        const desired = buildSystemdUnit();
        if (readFileSync(PATHS.linuxSystemd, "utf8") === desired) return false;
        writeFileSync(PATHS.linuxSystemd, desired);
        systemctlUser(["daemon-reload"]);
        return true;
      }
      if (existsSync(PATHS.linux)) {
        const desired = buildDesktopFile();
        if (readFileSync(PATHS.linux, "utf8") === desired) return false;
        writeFileSync(PATHS.linux, desired);
        return true;
      }
    }
  } catch {}
  return false;
}
