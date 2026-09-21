/**
 * System tray module — optional, silent fail if not supported
 */

import { spawn } from "child_process";
import readline from "readline";
import fs from "fs";
import path, { join } from "path";
import os from "os";
import { fileURLToPath } from "url";

const RUNTIME_MODULES = join(os.homedir(), ".9remote", "runtime", "node_modules");

let trayInstance = null;
let trayState = { port: 0, tunnelUrl: "", running: false };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PNG 64x64 base64 for macOS/Linux (generated from agent/ui/public/favicon.svg)
const TRAY_ICON_PNG = "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";

// Windows requires ICO format; resolve ICO path across dev + bundled layouts
const ICO_CANDIDATES = [
  path.join(__dirname, "assets", "trayIcon.ico"),           // dev: agent/cli/utils/assets/
  path.join(__dirname, "..", "assets", "trayIcon.ico"),      // bundled: agent/dist/assets/
];

// PowerShell tray script — resolved across dev + bundled layouts
const PS1_CANDIDATES = [
  path.join(__dirname, "assets", "tray.ps1"),                // dev: agent/cli/utils/assets/
  path.join(__dirname, "..", "assets", "tray.ps1"),          // bundled: agent/dist/assets/
];

function resolveExisting(candidates) {
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function getIconBase64() {
  if (process.platform === "win32") {
    for (const p of ICO_CANDIDATES) {
      try {
        if (fs.existsSync(p)) return fs.readFileSync(p).toString("base64");
      } catch {}
    }
    return TRAY_ICON_PNG;
  }
  return TRAY_ICON_PNG;
}

function isTraySupported() {
  // Desktop shell (Tauri) hosts the agent and owns the tray — never add a second icon
  if (process.env.NREMOTE_DESKTOP) return false;
  const platform = process.platform;
  if (!["darwin", "win32", "linux"].includes(platform)) return false;
  if (platform === "linux" && !process.env.DISPLAY) return false;
  return true;
}

function buildTooltip() {
  const { port, tunnelUrl, running } = trayState;
  const status = running
    ? (tunnelUrl ? "Tunnel ON" : "Local only")
    : "Idle";
  const url = `http://localhost:${port}`;
  // Windows tray tooltip limit is ~127 chars; keep it compact but informative
  return `9Remote • ${status}\nLocal: ${url}\nRight-click to open / quit`;
}

function buildMenu() {
  const { port, tunnelUrl } = trayState;
  const isWin = process.platform === "win32";
  const statusLine = tunnelUrl
    ? `9Remote (Port ${port}) • Tunnel ON`
    : `9Remote (Port ${port}) • Local only`;
  return {
    icon: getIconBase64(),
    title: isWin ? `9Remote - Port ${port}` : "",
    tooltip: buildTooltip(),
    items: [
      { title: statusLine, tooltip: tunnelUrl || `http://localhost:${port}`, checked: false, enabled: false },
      { title: "Open Web UI", tooltip: `Open http://localhost:${port} in your browser`, checked: false, enabled: true },
      { title: "Shutdown", tooltip: "Stop 9Remote server, tunnel and quit", checked: false, enabled: true },
    ],
  };
}

/**
 * Initialize system tray
 * @param {{ port: number, onQuit: () => void, onOpenUI: () => void }} options
 */
/** Resolve systray2 from runtime dir only — avoid legacy systray v1 cache */
function resolveSystray() {
  try {
    const mod = require(path.join(RUNTIME_MODULES, "systray2"));
    return mod.default?.default || mod.default || mod;
  } catch {
    return null;
  }
}

// Windows tray via PowerShell NotifyIcon — zero binary dep, AV-safe (R: no systray2 .exe)
function initWinTray({ port, onQuit, onOpenUI }) {
  const iconPath = resolveExisting(ICO_CANDIDATES);
  const scriptPath = resolveExisting(PS1_CANDIDATES);
  if (!iconPath || !scriptPath) return null;

  let ps;
  try {
    ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
        "-InputFormat", "Text", "-OutputFormat", "Text",
        "-File", scriptPath, "-IconPath", iconPath, "-Tooltip", `9Remote - Port ${port}`],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch { return null; }

  const send = (cmd) => { try { if (ps.stdin.writable) ps.stdin.write(`${JSON.stringify(cmd)}\n`, "utf8"); } catch {} };

  const rl = readline.createInterface({ input: ps.stdout });
  rl.on("line", (line) => {
    try {
      const evt = JSON.parse(line);
      if (evt.type !== "click") return;
      if (evt.index === 0) onOpenUI?.();
      else if (evt.index === 1) { onQuit?.(); killTray(); setTimeout(() => process.exit(0), 500); }
    } catch {}
  });
  ps.on("error", () => {});
  ps.stderr.on("data", () => {});

  ["Open Web UI", "Shutdown"].forEach((title, index) =>
    send({ action: "add-item", index, title, enabled: true }));

  return {
    _isWin: true,
    _setTooltip(text) { send({ action: "set-tooltip", text }); },
    sendAction() {},
    kill() {
      try { send({ action: "kill" }); } catch {}
      setTimeout(() => { try { if (ps && !ps.killed) ps.kill(); } catch {} }, 300);
    },
  };
}

export async function initTray({ port, onQuit, onOpenUI }) {
  if (!isTraySupported()) return null;

  // Windows: PowerShell NotifyIcon (no binary). Mac/Linux: systray2 Go binary.
  if (process.platform === "win32") {
    trayState = { port, tunnelUrl: "", running: true };
    trayInstance = initWinTray({ port, onQuit, onOpenUI });
    return trayInstance;
  }

  try {
    const SysTray = resolveSystray();
    if (!SysTray) return null;

    // Ensure binary is executable (npm tarball sometimes strips +x)
    const binByPlatform = { darwin: "tray_darwin_release", win32: "tray_windows_release.exe", linux: "tray_linux_release" };
    const binName = binByPlatform[process.platform];
    if (!binName) return null;
    const binPath = path.join(RUNTIME_MODULES, "systray2", "traybin", binName);
    if (!fs.existsSync(binPath)) return null;
    // Windows .exe needs no chmod; POSIX tarball sometimes strips +x
    if (process.platform !== "win32") { try { fs.chmodSync(binPath, 0o755); } catch {} }

    trayState = { port, tunnelUrl: "", running: true };
    trayInstance = new SysTray({ menu: buildMenu(), debug: false, copyDir: true });

    trayInstance.onClick((action) => {
      const title = action.item?.title || action.item;
      if (title === "Open Web UI") onOpenUI?.();
      else if (title === "Shutdown") {
        onQuit?.();
        killTray();
        setTimeout(() => process.exit(0), 500);
      }
    });

    // systray2 exposes ready() promise; legacy systray uses onReady/onError callbacks
    if (typeof trayInstance.ready === "function") {
      trayInstance.ready().catch(() => {});
    } else {
      trayInstance.onReady(() => {});
      trayInstance.onError(() => {});
    }

    return trayInstance;
  } catch {
    return null;
  }
}

/**
 * Update tray tooltip / status so the user knows current tunnel state.
 * Safe to call before tray is ready — values are captured for next refresh.
 */
export function updateTrayTooltip({ tunnelUrl, running } = {}) {
  if (tunnelUrl !== undefined) trayState.tunnelUrl = tunnelUrl;
  if (running !== undefined) trayState.running = running;
  if (!trayInstance) return;
  // Windows PS tray: tooltip-only IPC (no full menu rebuild)
  if (trayInstance._isWin) {
    trayInstance._setTooltip?.(buildTooltip());
    return;
  }
  try {
    trayInstance.sendAction({
      type: "update-menu",
      menu: buildMenu(),
      seq_id: -1,
    });
  } catch {}
}

export function killTray() {
  const instance = trayInstance;
  trayInstance = null;
  if (instance) {
    try { instance.kill(true); } catch {}
  }
}

/**
 * Show a native OS notification (balloon tip on Windows, toast on macOS/Linux).
 * Silent fail if the platform tool isn't available.
 * @param {{ title?: string, message: string }} opts
 */
export function showTrayNotification({ title = "9Remote", message }) {
  const platform = process.platform;
  if (!message) return;

  if (platform === "win32") {
    // Prefer Windows 10/11 Toast Notification (WinRT) so the popup actually
    // appears on modern Windows (ShowBalloonTip is effectively deprecated and
    // only lands silently in Action Center on Win10+). Falls back to the
    // classic NotifyIcon balloon tip if WinRT is unavailable (older Windows,
    // Server Core, constrained PowerShell).
    const esc = (s) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/'/g, "&apos;")
        .replace(/"/g, "&quot;");
    const escPs = (s) => String(s).replace(/'/g, "''");
    const appId = "9Remote";
    const toastXml =
      `<toast><visual><binding template="ToastText02">` +
      `<text id="1">${esc(title)}</text>` +
      `<text id="2">${esc(message)}</text>` +
      `</binding></visual></toast>`;
    const ps = [
      `try {`,
      `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;`,
      `[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null;`,
      `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;`,
      `$xml.LoadXml('${escPs(toastXml)}');`,
      `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml);`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${escPs(appId)}').Show($toast);`,
      `} catch {`,
      `Add-Type -AssemblyName System.Windows.Forms;`,
      `$n = New-Object System.Windows.Forms.NotifyIcon;`,
      `$n.Icon = [System.Drawing.SystemIcons]::Information;`,
      `$n.BalloonTipTitle = '${escPs(title)}';`,
      `$n.BalloonTipText = '${escPs(message)}';`,
      `$n.Visible = $true;`,
      `$n.ShowBalloonTip(5000);`,
      `Start-Sleep -Seconds 6;`,
      `$n.Dispose();`,
      `}`,
    ].join(" ");
    try {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      child.unref();
    } catch {}
    return;
  }

  if (platform === "darwin") {
    try {
      const esc = (s) => String(s).replace(/"/g, '\\"');
      const script = `display notification "${esc(message)}" with title "${esc(title)}"`;
      const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
      child.unref();
    } catch {}
    return;
  }

  // Linux / other POSIX
  try {
    const child = spawn("notify-send", [title, message], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {}
}

export function openBrowser(url) {
  const platform = process.platform;

  // Windows: prefer `rundll32.exe` (GUI subsystem — no cmd window flash) over
  // `cmd /c start` which briefly flashes a black console window even with
  // `windowsHide: true`. Fallback to cmd/start if rundll32 ever fails.
  if (platform === "win32") {
    try {
      const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return;
    } catch {}
    // Fallback: cmd /c start "" "url"
    try {
      const child = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } catch {}
    return;
  }

  if (platform === "darwin") {
    try {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
    } catch {}
    return;
  }

  // Linux: detach fully from controlling TTY so snap chromium / xdg-open
  // doesn't get killed when parent TUI mutates raw stdin or process group.
  // Try setsid first (creates new session, fully detaches), fallback chain.
  const launchers = [
    ["setsid", ["--fork", "xdg-open", url]],
    ["setsid", ["xdg-open", url]],
    ["xdg-open", [url]],
    ["gio", ["open", url]],
    ["sensible-browser", [url]],
    ["x-www-browser", [url]],
  ];
  for (const [cmd, args] of launchers) {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      });
      child.unref();
      return;
    } catch {}
  }
}
