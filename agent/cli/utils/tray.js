/**
 * System tray module — optional, silent fail if not supported
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
export async function initTray({ port, onQuit, onOpenUI }) {
  if (!isTraySupported()) return null;

  try {
    const mod = await import("systray");
    const SysTray = mod.default?.default || mod.default;

    trayState = { port, tunnelUrl: "", running: true };

    trayInstance = new SysTray({ menu: buildMenu(), debug: false, copyDir: true });
    // Tray helper is a direct child of agent; no separate PID file needed.
    // `taskkill /F /T /PID <agent>` at update time terminates it along with
    // the agent tree — safer than matching by image name.

    trayInstance.onClick((action) => {
      if (action.item.title === "Open Web UI") {
        onOpenUI?.();
      } else if (action.item.title === "Shutdown") {
        onQuit?.();
        killTray();
        setTimeout(() => process.exit(0), 500);
      }
    });

    trayInstance.onReady(() => {});
    trayInstance.onError(() => {});

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

  // Linux / other POSIX
  try {
    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {}
}
