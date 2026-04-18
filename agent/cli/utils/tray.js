/**
 * System tray module — optional, silent fail if not supported
 */

import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

let trayInstance = null;

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

/**
 * Initialize system tray
 * @param {{ port: number, onQuit: () => void, onOpenUI: () => void }} options
 */
export async function initTray({ port, onQuit, onOpenUI }) {
  if (!isTraySupported()) return null;

  try {
    const mod = await import("systray");
    const SysTray = mod.default?.default || mod.default;

    const isWin = process.platform === "win32";
    const menu = {
      icon: getIconBase64(),
      title: isWin ? `9Remote - Port ${port}` : "",
      tooltip: `9Remote - Port ${port}`,
      items: [
        { title: `9Remote (Port ${port})`, tooltip: "Server is running", enabled: false },
        { title: "Open Web UI", tooltip: "Open in browser", enabled: true },
        { title: "Quit", tooltip: "Stop server and exit", enabled: true },
      ],
    };

    trayInstance = new SysTray({ menu, debug: false, copyDir: true });

    trayInstance.onClick((action) => {
      if (action.item.title === "Open Web UI") {
        onOpenUI?.();
      } else if (action.item.title === "Quit") {
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

export function killTray() {
  const instance = trayInstance;
  trayInstance = null;
  if (instance) {
    try { instance.kill(true); } catch {}
  }
}

export function openBrowser(url) {
  const platform = process.platform;
  // Windows: `start` is a cmd.exe builtin, must run via shell
  if (platform === "win32") {
    exec(`start "" "${url}"`, { shell: "cmd.exe" }, () => {});
    return;
  }
  const cmd = platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
