// Electron shell for 9Remote.
//
// Replaces the Tauri shell on macOS because WKWebView mishandles the synthetic
// backspace+char sequences Vietnamese IMEs (OpenKey/EVKey) emit into xterm.js.
// Chromium handles them correctly.

import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage } from "electron";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { SERVER_PORT, VITE_PORT, WINDOW, ALMOST_READY_MS, TRAY_ICON_SIZE } from "./constants.js";
import { startAgent, stopAgent, waitForHealth, waitForUrl, findCli, installAgent } from "./agent.js";
import { checkPermissions, requestPermission } from "./permissions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NINEREMOTE_ENV === "development";

let win = null;
let tray = null;
let quitting = false;

const emit = (name, payload) => win?.webContents.send(name, payload);

function createWindow() {
  win = new BrowserWindow({
    ...WINDOW,
    title: "9Remote",
    center: true,
    show: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(join(__dirname, "..", "dist", "index.html"));

  // Close button hides to tray — the agent keeps serving remote clients.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  // Keep external links in the user's browser, not in the app frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function createTray() {
  const icon = nativeImage
    .createFromPath(join(__dirname, "..", "src-tauri", "icons", "trayIcon.png"))
    .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  tray = new Tray(icon);
  tray.setToolTip("9Remote");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Show/Hide Window",
      accelerator: "CmdOrCtrl+H",
      click: () => (win?.isVisible() ? win.hide() : (win?.show(), win?.focus())),
    },
    { type: "separator" },
    { label: "Quit 9Remote", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
  ]));
}

async function boot() {
  if (isDev) {
    // Vite only starts after the agent's health check passes, so wait for it.
    emit("setup_progress", "Waiting for dev server...");
    const url = `http://localhost:${VITE_PORT}`;
    if (!(await waitForUrl(url))) return emit("setup_error", "Vite dev server did not start.");
    win.loadURL(url);
    return;
  }

  // First run has no agent yet — install it globally with the bundled npm.
  if (!findCli()) {
    emit("setup_progress", "Installing 9Remote agent (first run)...");
    if (!(await installAgent((line) => console.log(line))))
      return emit("setup_error", "Failed to install the 9Remote agent. Check your internet connection.");
  }

  emit("setup_progress", "Starting 9Remote server...");
  const { error } = startAgent((line) => console.log(line));
  if (error) {
    emit("setup_error", error);
    return;
  }

  let warned = false;
  const ready = await waitForHealth((elapsed) => {
    if (!warned && elapsed >= ALMOST_READY_MS) {
      warned = true;
      emit("setup_progress", "Almost ready...");
    }
  });

  if (!ready) {
    emit("setup_error", "Server did not start in time. Check Console.app for [9remote] logs.");
    return;
  }
  emit("setup_ready");
  win.loadURL(`http://localhost:${SERVER_PORT}`);
}

// ── IPC — names match the Tauri commands the agent UI already invokes ──

ipcMain.handle("check_permissions", () => checkPermissions());
ipcMain.handle("request_permission", (_e, args) => requestPermission(args?.permissionType ?? args));
ipcMain.handle("quit_app", () => app.quit());

// setBadgeCount handles the macOS dock badge and the Linux Unity launcher;
// it no-ops elsewhere. setOverlayIcon(null) only ever cleared, never drew.
ipcMain.handle("set_badge", (_e, args) => {
  app.setBadgeCount(Math.max(0, args?.count ?? 0));
});

ipcMain.handle("show_notif", (_e, { title, body } = {}) => {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
});

// ── Lifecycle ──

// Second launch focuses the running instance instead of starting a rival agent.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { win?.show(); win?.focus(); });

app.whenReady().then(() => {
  // Packaged builds get the icon from Info.plist; `electron .` needs it set at runtime.
  if (isDev && process.platform === "darwin")
    app.dock.setIcon(join(__dirname, "..", "src-tauri", "icons", "icon.png"));
  createWindow();
  createTray();
  boot();
  app.on("activate", () => (win ? (win.show(), win.focus()) : createWindow()));
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", stopAgent);
// Tray app: closing the last window must not end the process.
app.on("window-all-closed", () => {});
