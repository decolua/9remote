#!/usr/bin/env node

import inquirer from "inquirer";
import chalk from "chalk";
import qrcode from "qrcode-terminal";
import { spawn, execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import { getConsistentMachineId } from "./utils/machineId.js";
import { generateApiKeyWithMachine } from "./utils/apiKey.js";
import { loadKey, saveKey, loadState, saveState, clearState, readAndClearCmd, writeCmd } from "./utils/state.js";
import { createTempKey } from "./utils/token.js";
import { checkAndUpdate, checkLatestVersion, stopRunningInstances } from "./utils/updateChecker.js";
import { spawnQuickTunnel, killCloudflared, resetRestartCounter, ensureCloudflared } from "./utils/cloudflared.js";
import { showBanner, getBannerText, renderProgress, resetProgress, updateProgressDesc, setProgressInfo, selectMenu, confirm as tuiConfirm, subscribeSSE, openPermissionPane, showDeviceApproval } from "./utils/tui.js";
import { checkPermissions } from "./utils/permissions.js";
import { initTray, killTray, openBrowser } from "./utils/tray.js";
import { STEP, DEBUG, browserFetch } from "../lib/constants.js";

const skipUpdate = process.argv.includes("--skip-update");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const STANDALONE_SERVER = path.resolve(__dirname, "../dist/server.cjs");
const DEV_SERVER = path.resolve(__dirname, "../index.js");
const WORKER_URL = "https://9remote.cc";
const SERVER_PORT = 2208;
const MAX_RESTART_ATTEMPTS = 10;
const RESTART_WINDOW_MS = 60000; // 1 minute

const ORANGE = chalk.rgb(230, 138, 110);
const ORANGE_DIM = chalk.rgb(200, 120, 95);

// Submenus set this to receive SSE-driven refreshes (permissions, state, ...) while open
let activeSubmenuRefresh = null;

/** Ensure API key exists, create if missing */
async function ensureKeyData() {
  const machineId = await getConsistentMachineId();
  let keyData = loadKey();
  if (!keyData.key) {
    const { key } = generateApiKeyWithMachine(machineId);
    keyData = saveKey(machineId, key, "Default");
  }
  return keyData;
}

function getVersion() {
  if (typeof __CLI_VERSION__ !== "undefined") {
    return __CLI_VERSION__;
  }
  
  try {
    const packagePath = path.join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    return packageJson.version;
  } catch {
    return "unknown";
  }
}

function showQRCode(url, title = "📱 Scan QR to connect:") {
  console.log(ORANGE(`\n${title}`));
  qrcode.generate(url, { small: true, type: "terminal", margin: 0 }, (qr) => {
    console.log(qr.trim());
  });
}

function buildQRString(url) {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true, type: "terminal", margin: 0 }, (qr) => {
      resolve(ORANGE_DIM("📱 Scan QR to connect:") + "\n" + qr.trim());
    });
  });
}

async function showConnectionInfo(selectedKey, tunnelUrl) {
  const tempKeyData = await createTempKey(selectedKey, WORKER_URL);
  
  if (!tempKeyData) {
    console.log(chalk.red("❌ Failed to create temp key"));
    return;
  }

  const connectUrl = `${WORKER_URL}/login?k=${tempKeyData.tempKey}`;
  const width = Math.min(44, process.stdout.columns || 55);

  await setStep(STEP.READY, {
    tunnelUrl,
    oneTimeKey: tempKeyData.tempKey,
    oneTimeKeyExpiresAt: tempKeyData.expiresAt,
    permanentKey: selectedKey,
    qrUrl: connectUrl,
    workerUrl: WORKER_URL,
  });

  showQRCode(connectUrl);

  console.log(chalk.gray(`\nQR will expire in 30 minutes (one-time use)\n`));
  
  console.log(ORANGE("═".repeat(width)));
  
  const appLabel = "App URL";
  const appValue = `${WORKER_URL}/login`;
  console.log(chalk.white(appLabel.padEnd(14)) + chalk.gray(appValue));
  
  const keyLabel = "One-Time Key";
  const keyValue = tempKeyData.tempKey;
  console.log(chalk.white(keyLabel.padEnd(14)) + ORANGE.bold(keyValue));
  
  const permLabel = "Key";
  const permValue = selectedKey;
  console.log(chalk.white(permLabel.padEnd(14)) + chalk.gray(permValue));
  
  console.log(ORANGE("═".repeat(width)));
}

async function buildMenuHeader(oneTimeKey, permanentKey, connectUrl, tunnelUrl = "") {
  const w = Math.min(44, process.stdout.columns || 44);
  const lines = [];

  if (oneTimeKey && connectUrl) {
    const qrBlock = await buildQRString(connectUrl);
    lines.push(qrBlock);
    lines.push(chalk.gray("\nQR expires in 30 minutes (one-time use)\n"));
  } else {
    lines.push(chalk.gray("\n(One-time key used — generate a new one from menu)\n"));
  }

  lines.push(
    ORANGE("═".repeat(w)),
    chalk.white("App URL".padEnd(14))      + chalk.gray(`${WORKER_URL}/login`),
  );

  if (DEBUG.showTunnelUrlInMenu) {
    lines.push(chalk.white("Tunnel".padEnd(14)) + (tunnelUrl ? chalk.cyan(tunnelUrl) : chalk.gray("—")));
  }

  lines.push(
    chalk.white("One-Time Key".padEnd(14)) + (oneTimeKey ? ORANGE.bold(oneTimeKey) + chalk.dim("  (expires in 30m)") : chalk.gray("—")),
    chalk.white("Key".padEnd(14))          + chalk.dim(permanentKey),
    ORANGE("═".repeat(w)),
  );
  return lines.join("\n");
}

function killProcessOnPort(port) {
  try {
    if (process.platform === "win32") {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`, { stdio: "ignore", windowsHide: true });
    } else {
      const nullDevice = "/dev/null";
      execSync(`lsof -ti:${port} | xargs kill -9 2>${nullDevice} || true`, { stdio: "ignore" });
    }
  } catch { }
}

function startServerWithRestart(onReady, onServerCrash) {
  const restartTimes = [];
  let currentProcess = null;
  let isShuttingDown = false;
  let isFirstStart = true;

  const spawnServer = () => {
      if (isFirstStart) {
      killProcessOnPort(SERVER_PORT);
      isFirstStart = false;
    }

      const useDevServer = process.env.NODE_ENV === "development" && fs.existsSync(DEV_SERVER);
    const serverPath = useDevServer ? DEV_SERVER : STANDALONE_SERVER;
    
    if (!fs.existsSync(serverPath)) {
      console.error(`❌ Server not found: ${serverPath}`);
      process.exit(1);
    }
    
      const spawnEnv = { ...process.env, PORT: String(SERVER_PORT) };
    if (!useDevServer) delete spawnEnv.NODE_ENV;

    currentProcess = spawn("node", [serverPath], {
      cwd: path.dirname(serverPath),
      stdio: "inherit",
      detached: false,
      windowsHide: true,
      env: spawnEnv,
    });
    

    currentProcess.on("exit", (code, signal) => {
      if (isShuttingDown) {
        return;
      }

      // Check if it's a crash (non-zero exit code or unexpected signal)
      if (code !== 0 || signal) {
        console.log(chalk.red(`\n💥 Server crashed (code: ${code}, signal: ${signal})`));

        // Check restart limit
        const now = Date.now();
        restartTimes.push(now);
        
              while (restartTimes.length > 0 && restartTimes[0] < now - RESTART_WINDOW_MS) {
          restartTimes.shift();
        }

        if (restartTimes.length > MAX_RESTART_ATTEMPTS) {
          console.log(chalk.red(`❌ Too many restarts (${MAX_RESTART_ATTEMPTS} in ${RESTART_WINDOW_MS / 1000}s). Giving up.`));
          process.exit(1);
        }

        console.log(chalk.yellow(`🔄 Restarting server... (attempt ${restartTimes.length}/${MAX_RESTART_ATTEMPTS})`));
        
        // ✅ Callback để restart cloudflared
        if (onServerCrash) {
          console.log(chalk.yellow("✅ Restarting tunnel connection..."));
          onServerCrash();
        }
        
              setTimeout(() => {
          spawnServer();
        }, 1000);
      }
    });

    currentProcess.on("error", (err) => {
      console.log(chalk.red(`❌ Server error: ${err.message}`));
    });

    if (onReady) {
      onReady(currentProcess);
    }
  };

  spawnServer();

  return {
    getProcess: () => currentProcess,
    shutdown: () => {
      isShuttingDown = true;
      if (currentProcess) {
        currentProcess.kill();
      }
    }
  };
}

let exitHandlerRegistered = false;

function setupExitHandler(serverManager, tunnelProcess, apiKey) {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  
  process.on("SIGINT", async () => {
    console.log(chalk.yellow("\n\n🛑 Stopping server..."));
    
    serverManager.shutdown();
    if (tunnelProcess) tunnelProcess.kill();
    killProcessOnPort(SERVER_PORT);
    resetRestartCounter();
    clearState();
    
    console.log(chalk.green("✅ Server stopped"));
    process.exit(0);
  });
}

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

/** Local API helpers */
async function apiPost(path, data) {
  try {
    return await fetch(`http://localhost:${SERVER_PORT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch { return null; }
}

async function apiGet(path) {
  try {
    const res = await fetch(`http://localhost:${SERVER_PORT}${path}`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function pushUiState(data) {
  await apiPost("/api/ui/state", data);
}

// DRY: single source for step progression — updates both terminal progress + web UI state.
// Terminal rendering only active in TUI mode (guarded by isTuiActive flag).
let isTuiActive = false;
async function setStep(step, extra = {}) {
  if (isTuiActive) renderProgress(step - 1, step > STEP.PREPARING);
  await pushUiState({ step, stepDesc: "", ...extra });
}

// DRY: single handler for cloudflared binary progress → updates both TUI + web UI.
function onBinaryProgress({ phase, percent }) {
  const text = phase === "download"
    ? `Downloading tunnel binary ${percent ?? 0}%`
    : "Extracting tunnel binary";
  if (isTuiActive) updateProgressDesc(text);
  pushUiState({ stepDesc: text });
}

async function updateTunnelUrl(selectedKey, tunnelUrl) {
  const lanIp = getLanIp();
  try {
    await browserFetch(`${WORKER_URL}/api/session/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: selectedKey,
        tunnelUrl,
        localIp: lanIp ? `${lanIp}:${SERVER_PORT}` : null
      })
    });
  } catch { }
}

async function startServerAndTunnel(selectedKey) {
  console.log(ORANGE("\n🚀 Starting server..."));
  await setStep(STEP.PREPARING);

  // Kill existing cloudflared process
  try {
    killCloudflared();
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch { }

  // Create session on worker
  try {
    const res = await browserFetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: selectedKey }),
    });
    if (!res.ok) { console.log(chalk.red(`❌ Session create failed: ${res.status}`)); return null; }
  } catch (e) {
    console.log(chalk.red(`❌ Session create failed: ${e.message}`)); return null;
  }

  // Skip spawning server if already running (e.g. nodemon in dev mode)
  const alreadyRunning = await isServerRunning();
  const serverManager = alreadyRunning
    ? { getProcess: () => null, shutdown: () => {} }
    : startServerWithRestart(null, null);

  if (!alreadyRunning) await new Promise(resolve => setTimeout(resolve, 2000));

  console.log(ORANGE("✅ Starting tunnel..."));
  await setStep(STEP.CONNECTING);

  // Spawn quick tunnel — URL comes directly from cloudflared stdout
  let tunnelProcess, tunnelUrl;
  try {
    const result = await spawnQuickTunnel(SERVER_PORT, async (newUrl) => {
      // URL rotated — update worker + UI
      console.log(ORANGE(`🔄 Tunnel URL rotated: ${newUrl}`));
      await updateTunnelUrl(selectedKey, newUrl);
      pushUiState({ tunnelUrl: newUrl });
    });
    tunnelProcess = result.child;
    tunnelUrl = result.tunnelUrl;
  } catch (error) {
    console.log(chalk.red(`❌ Failed to start tunnel: ${error.message}`));
    serverManager.shutdown();
    return null;
  }

  // Health check tunnel from outside before proceeding
  const tunnelReady = await waitForTunnelReady(tunnelUrl);
  if (!tunnelReady) {
    console.log(chalk.yellow("\n⚠️  Tunnel health check timed out, proceeding anyway..."));
  }

  // Save tunnelUrl to worker DB
  await updateTunnelUrl(selectedKey, tunnelUrl);

  // Save local state
  saveState({
    apiKey: selectedKey,
    tunnelUrl,
    serverPid: serverManager.getProcess()?.pid,
    tunnelPid: tunnelProcess.pid
  });

  return { serverManager, tunnelProcess, tunnelUrl };
}

async function tuiMode() {
  console.clear();
  resetProgress();
  isTuiActive = true;
  await setStep(STEP.PREPARING);

  let keyData = await ensureKeyData();

  let tuiServerMgr = { getProcess: () => null, shutdown: () => {} };
  const alreadyRunning = await isServerRunning();
  if (!alreadyRunning) {
    tuiServerMgr = startServerWithRestart(null, null);
    // Poll until server ready instead of fixed sleep
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(await isServerRunning())) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  try { killCloudflared(); await new Promise((r) => setTimeout(r, 300)); } catch {}

  await ensureCloudflared(onBinaryProgress);

  await setStep(STEP.CONNECTING);

  try {
    const res = await browserFetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: keyData.key }),
    });
    if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
  } catch (err) {
    console.log(chalk.red(`\n❌ Failed to connect: ${err.message}`));
    process.exit(1);
  }

  await setStep(STEP.TUNNELING);

  let tunnelProcess, tunnelUrl;
  try {
    const result = await spawnQuickTunnel(SERVER_PORT, async (newUrl) => {
      await updateTunnelUrl(keyData.key, newUrl);
      await pushUiState({ tunnelUrl: newUrl });
    });
    tunnelProcess = result.child;
    tunnelUrl = result.tunnelUrl;
  } catch (err) {
    console.log(chalk.red(`\n❌ Tunnel failed: ${err.message}`));
    process.exit(1);
  }

  await setStep(STEP.VERIFYING);
  const tunnelReady = await waitForTunnelReady(tunnelUrl);
  if (!tunnelReady) {
    console.log(chalk.yellow("\n⚠️  Tunnel health check timed out, proceeding anyway..."));
  }

  await updateTunnelUrl(keyData.key, tunnelUrl);
  saveState({ apiKey: keyData.key, tunnelUrl, tunnelPid: tunnelProcess.pid });

  const tempKeyData = await createTempKey(keyData.key, WORKER_URL);
  const connectUrl = tempKeyData
    ? `${WORKER_URL}/login?k=${tempKeyData.tempKey}`
    : `${WORKER_URL}/login`;

  await setStep(STEP.READY, {
    tunnelUrl,
    oneTimeKey: tempKeyData?.tempKey || "",
    oneTimeKeyExpiresAt: tempKeyData?.expiresAt || null,
    permanentKey: keyData.key,
    qrUrl: connectUrl,
    workerUrl: WORKER_URL,
  });
  await new Promise((r) => setTimeout(r, 1000));

  let currentOneTimeKey = tempKeyData?.tempKey || "";
  let currentConnectUrl = connectUrl;
  let currentTunnelUrl = tunnelUrl;

  let menuHeader = await buildMenuHeader(currentOneTimeKey, keyData.key, currentConnectUrl, currentTunnelUrl);

  let triggerMenuRedraw = null;
  const logBuffer = [];
  const MAX_LOG_LINES = 200;

  let deviceApprovalBusy = false;
  const stopSSE = subscribeSSE(SERVER_PORT, async (type, data) => {
    if (type === "log" && data.message) {
      logBuffer.push(data.message);
      if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    } else if (type === "state") {
      const newKey = data.permanentKey || keyData.key;
      // Explicit check: "" means cleared (one-time key consumed), preserve existing if undefined
      const newOtk = data.oneTimeKey !== undefined ? data.oneTimeKey : currentOneTimeKey;
      const newUrl = data.qrUrl !== undefined ? data.qrUrl : currentConnectUrl;
      const newTunnel = data.tunnelUrl !== undefined ? data.tunnelUrl : currentTunnelUrl;
      if (newOtk !== currentOneTimeKey || newKey !== keyData.key || newTunnel !== currentTunnelUrl) {
        currentOneTimeKey = newOtk;
        currentConnectUrl = newUrl;
        currentTunnelUrl = newTunnel;
        if (data.permanentKey) keyData = { ...keyData, key: data.permanentKey };
        menuHeader = await buildMenuHeader(currentOneTimeKey, keyData.key, currentConnectUrl, currentTunnelUrl);
        triggerMenuRedraw?.();
      }
    } else if (type === "permissions") {
      // desktopEnabled or permission values changed — refresh both main menu and active submenu
      activeSubmenuRefresh?.();
      triggerMenuRedraw?.();
    } else if (type === "deviceApproval" && data.action === "pending") {
      if (deviceApprovalBusy) return;
      deviceApprovalBusy = true;
      const approved = await showDeviceApproval(data.deviceId, data.ip);
      const endpoint = approved ? "approve" : "reject";
      await apiPost(`/api/device/${endpoint}`, { socketId: data.socketId });
      deviceApprovalBusy = false;
      triggerMenuRedraw?.();
    }
  });

  setupExitHandler({
    getProcess: tuiServerMgr.getProcess,
    shutdown: () => { tuiServerMgr.shutdown(); stopSSE(); }
  }, tunnelProcess, keyData.key);

  // Handle web UI Start/Stop commands while TUI is running
  let activeTunnel = tunnelProcess;
  setupCmdPoller(() => activeTunnel, (t) => { activeTunnel = t; }, keyData.key);

  await tuiMenuLoop(
    keyData, tunnelUrl,
    () => menuHeader,
    (h) => { menuHeader = h; },
    (cb) => { triggerMenuRedraw = cb; },
    () => { tuiServerMgr.shutdown(); killProcessOnPort(SERVER_PORT); stopSSE(); },
    logBuffer
  );
}

async function fetchServerState() {
  const d = await apiGet("/api/ui/state");
  return { desktopEnabled: !!d?.desktopEnabled, remoteAvailable: !!d?.remoteAvailable };
}

/**
 * Main menu loop after Ready.
 * @param {object} keyData
 * @param {string} tunnelUrl
 * @param {() => string} getHeader - live header getter (SSE may update it)
 * @param {(newHeader: string) => void} setHeader - update header from inside loop
 * @param {(cb: () => void) => void} onRedrawRegister - register redraw callback
 */
async function tuiMenuLoop(keyData, tunnelUrl, getHeader = () => "", setHeader = () => {}, onRedrawRegister = () => {}, onCtrlC = null, logBuffer = []) {
  while (true) {
    const { desktopEnabled: desktopOn, remoteAvailable } = await fetchServerState();

    const items = [
      { label: "Open Web UI", action: "webui" },
      { label: "New One-Time Key", action: "otk" },
      { label: "Regenerate Permanent Key", action: "regen" },
    ];
    if (remoteAvailable) {
      const desktopLabel = `Remote Desktop: ${desktopOn ? chalk.green("ON") : chalk.gray("OFF")}  ▶`;
      items.push({ label: desktopLabel, action: "desktop" });
    }
    items.push(
      { label: "Manage Devices  \u25b6", action: "devices" },
      { label: `View Logs (${logBuffer.length})`, action: "logs" },
      { label: chalk.gray("Exit"), action: "exit" },
    );

    let redrawMenu = null;
    onRedrawRegister(() => redrawMenu?.());

    const idx = await selectMenu("", items, 0, getHeader, (setRedraw) => {
      redrawMenu = setRedraw;
    }, onCtrlC);

    const action = idx >= 0 ? items[idx].action : "exit";

    if (action === "webui") {
      const url = `http://localhost:${SERVER_PORT}`;
      openBrowser(url);
      console.log(chalk.green(`\n🌐 Opening ${url}\n`));

    } else if (action === "otk") {
      const newTempKey = await createTempKey(keyData.key, WORKER_URL);
      if (newTempKey) {
        const newConnectUrl = `${WORKER_URL}/login?k=${newTempKey.tempKey}`;
        setHeader(await buildMenuHeader(newTempKey.tempKey, keyData.key, newConnectUrl, tunnelUrl));
        await pushUiState({ oneTimeKey: newTempKey.tempKey, oneTimeKeyExpiresAt: newTempKey.expiresAt, qrUrl: newConnectUrl });
      }

    } else if (action === "regen") {
      const confirmed = await tuiConfirm(chalk.yellow("⚠️  Replace current key and disconnect all sessions? Continue?"));
      if (confirmed) {
        const machineId = await getConsistentMachineId();
        const { key } = generateApiKeyWithMachine(machineId);
        keyData = saveKey(machineId, key, keyData.name || "Default");
        await pushUiState({ permanentKey: keyData.key });
        const newTmp = await createTempKey(keyData.key, WORKER_URL);
        if (newTmp) {
          const newUrl = `${WORKER_URL}/login?k=${newTmp.tempKey}`;
          setHeader(await buildMenuHeader(newTmp.tempKey, keyData.key, newUrl, tunnelUrl));
          await pushUiState({ oneTimeKey: newTmp.tempKey, oneTimeKeyExpiresAt: newTmp.expiresAt, qrUrl: newUrl });
        }
      }

    } else if (action === "desktop") {
      await tuiDesktopMenu();

    } else if (action === "devices") {
      await tuiDevicesMenu();

    } else if (action === "logs") {
      await tuiLogsView(logBuffer);

    } else {
      killProcessOnPort(SERVER_PORT);
      console.log(chalk.gray("\nGoodbye!\n"));
      process.exit(0);
    }
  }
}

/** View logs screen — scrollable, ESC to go back */
async function tuiLogsView(logBuffer) {
  const header = logBuffer.length
    ? logBuffer.join("\n")
    : chalk.gray("  No logs yet");
  await selectMenu("Logs", [{ label: chalk.gray("← Back") }], 0, header);
}

/**
 * Remote Desktop submenu.
 * All state (desktopEnabled + permissions) fetched from server — no local tracking.
 */
async function tuiDesktopMenu() {
  while (true) {
    // State captured in closure — SSE may mutate items in-place while menu is open
    let desktopOn = false;
    let perms = { screenRecording: false, accessibility: false };

    const buildLabels = () => ({
      toggle: `Toggle: ${desktopOn ? chalk.green("ON  → turn OFF") : chalk.gray("OFF → turn ON")}`,
      sr: `Screen Recording          ${perms.screenRecording ? chalk.green("✓") : chalk.red("✗ (click to grant)")}`,
      ax: `Mouse & Keyboard control  ${perms.accessibility  ? chalk.green("✓") : chalk.red("✗ (click to grant)")}`,
    });

    const items = [
      { label: "" },
      { label: "" },
      { label: "" },
      { label: chalk.gray("← Back") },
    ];

    let redrawMenu = null;
    const syncFromServer = async () => {
      const s = await apiGet("/api/ui/state") || {};
      desktopOn = !!s.desktopEnabled;
      perms = { screenRecording: !!s.screenRecording, accessibility: !!s.accessibility };
      const L = buildLabels();
      items[0].label = L.toggle;
      items[1].label = L.sr;
      items[2].label = L.ax;
      redrawMenu?.();
    };

    await syncFromServer();
    // Register SSE-driven refresh while this submenu is active
    activeSubmenuRefresh = syncFromServer;
    const idx = await selectMenu("Remote Desktop", items, 0, "", (setRedraw) => { redrawMenu = setRedraw; });
    activeSubmenuRefresh = null;

    if (idx === 0) {
      await apiPost("/api/desktop/toggle", { enabled: !desktopOn });
    } else if (idx === 1 && !perms.screenRecording) {
      if (!await apiPost("/api/permissions/request", { type: "screenRecording" })) openPermissionPane("screenRecording");
    } else if (idx === 2 && !perms.accessibility) {
      if (!await apiPost("/api/permissions/request", { type: "accessibility" })) openPermissionPane("accessibility");

    } else if (idx === 3 || idx === -1) {
      return; // Back
    }
  }
}

async function tuiDevicesMenu() {
  while (true) {
    const data = await apiGet("/api/device/approved");
    const devices = data?.devices || [];

    const items = [
      ...devices.map((d) => {
        const short = d.deviceId.slice(0, 8);
        const date = d.approvedAt ? new Date(d.approvedAt).toLocaleString() : "unknown";
        return { label: `${short}...  ${chalk.dim(date)}` };
      }),
      { label: chalk.gray("\u2190 Back") },
    ];

    const title = `Approved Devices (${devices.length})`;
    const idx = await selectMenu(title, items, items.length - 1);

    if (idx === -1 || idx === devices.length) return; // Back/ESC

    // Remove selected device
    const deviceId = devices[idx].deviceId;
    const confirmed = await tuiConfirm(chalk.yellow(`Remove device ${deviceId.slice(0, 8)}...?`));
    if (confirmed) await apiPost("/api/device/remove", { deviceId });
  }
}

async function autoStartDev() {
  showBanner(getVersion());
  let keyData = await ensureKeyData();
  console.log(chalk.gray(`Using key: ${keyData.key.slice(0, 20)}... (${keyData.name})`));

  const result = await startServerAndTunnel(keyData.key);
  if (!result) process.exit(1);

  const { serverManager, tunnelProcess, tunnelUrl } = result;

  await showConnectionInfo(keyData.key, tunnelUrl);
  setupExitHandler(serverManager, tunnelProcess, keyData.key);
  
  let activeTunnel = tunnelProcess;
  setupCmdPoller(() => activeTunnel, (t) => { activeTunnel = t; }, keyData.key);

  // Push stats to UI every 5s
  const startTime = Date.now();
  setInterval(() => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = uptime % 60;
    pushUiState({ uptime: `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` });
  }, 5000);

  await new Promise(() => { });
}

function setupCmdPoller(getActiveTunnel, setActiveTunnel, apiKey) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    const cmd = readAndClearCmd();
    if (!cmd) return;
    busy = true;
    try {

    if (cmd === "stop-tunnel") {
      const tunnel = getActiveTunnel();
      if (tunnel) {
        tunnel.kill();
        setActiveTunnel(null);
        console.log(chalk.yellow("🛑 Tunnel stopped"));
      }
      await setStep(STEP.STOPPED, { tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null });
    }

    if (cmd === "start-tunnel") {
      if (getActiveTunnel()) { busy = false; return; } // already running
      console.log(ORANGE("🚀 Starting tunnel..."));
      try {
        await setStep(STEP.PREPARING);
        await ensureCloudflared(onBinaryProgress);

        await setStep(STEP.CONNECTING);
        const sessionResponse = await browserFetch(`${WORKER_URL}/api/session/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        if (!sessionResponse.ok) throw new Error(`Session create failed: ${sessionResponse.status}`);

        await setStep(STEP.TUNNELING);
        const result = await spawnQuickTunnel(SERVER_PORT, async (newUrl) => {
          await updateTunnelUrl(apiKey, newUrl);
          await pushUiState({ tunnelUrl: newUrl });
        });
        setActiveTunnel(result.child);

        await setStep(STEP.VERIFYING);
        const tunnelOk = await waitForTunnelReady(result.tunnelUrl);
        if (!tunnelOk) {
          console.log(chalk.yellow("\n⚠️  Tunnel health check timed out, proceeding anyway..."));
        }

        await updateTunnelUrl(apiKey, result.tunnelUrl);

        // Hold for 3s so UI sees all steps complete before showing Ready screen
        await new Promise(r => setTimeout(r, 3000));
        await showConnectionInfo(apiKey, result.tunnelUrl);
      } catch (err) {
        console.log(chalk.red(`❌ Failed to start tunnel: ${err.message}`));
        await setStep(STEP.STOPPED);
      }
    }

    if (cmd === "regenerate-key") {
      const machineId = await getConsistentMachineId();
      const { key } = generateApiKeyWithMachine(machineId);
      const existing = loadKey();
      saveKey(machineId, key, existing?.name || "Default");
      await pushUiState({ permanentKey: key });
      console.log(chalk.green(`✅ Key regenerated: ${key}`));
    }

    } finally {
      busy = false;
    }
  }, 1000);
}

async function waitForTunnelReady(tunnelUrl, { intervalMs = 2000, timeoutMs = 120000 } = {}) {
  const healthUrl = `${tunnelUrl}/api/health`;
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const res = await browserFetch(healthUrl, {
        signal: AbortSignal.timeout(5000),
      });
      updateProgressDesc(`#${attempt} → ${res.status}`);
      if (res.ok) {
        await new Promise(r => setTimeout(r, 2000));
        return true;
      }
    } catch (err) {
      updateProgressDesc(`#${attempt} → ${err.cause?.code || err.code || err.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function isServerRunning() {
  return !!(await apiGet("/api/health"));
}

/** Spawn background process with --tray flag, open browser, exit current process */
async function launchBackground() {
  const uiUrl = `http://localhost:${SERVER_PORT}`;

  // If server already running, just open browser and exit
  if (await isServerRunning()) {
    openBrowser(uiUrl);
    console.log(chalk.green(`\n🌐 9Remote already running at ${uiUrl}`));
    console.log(chalk.gray("💡 Tray icon already active. Right-click tray to manage.\n"));
    process.exit(0);
  }

  // Spawn CLI itself with --tray — tray logic lives in CLI, not server
  // Bundle: __dirname = dist/,      entry = dist/cli.cjs
  // Dev:    __dirname = agent/cli/, entry = agent/cli/index.js
  const scriptPath = typeof __CLI_VERSION__ !== "undefined"
    ? path.resolve(__dirname, "cli.cjs")
    : path.resolve(__dirname, "index.js");
  const bgArgs = [scriptPath, "--tray"];

  const themeArg = process.argv.find(a => a.startsWith("--theme="));
  if (themeArg) bgArgs.push(themeArg);

  // Redirect child stdout/stderr to log file for debugging crashes
  const logDir = path.join(os.homedir(), ".9remote");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "bg.log");
  const logFd = fs.openSync(logPath, "a");
  fs.writeSync(logFd, `\n\n=== ${new Date().toISOString()} spawn bg ===\n`);

  const bg = spawn(process.execPath, bgArgs, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  bg.unref();

  // Wait briefly and verify server came up; surface error if not
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    if (await isServerRunning()) { ready = true; break; }
    await new Promise(r => setTimeout(r, 300));
  }

  if (!ready) {
    console.log(chalk.red(`\n❌ Background server failed to start.`));
    console.log(chalk.gray(`   Check log: ${logPath}\n`));
    process.exit(1);
  }

  openBrowser(uiUrl);
  console.log(chalk.green(`\n🌐 9Remote running at ${uiUrl} (PID: ${bg.pid})`));
  console.log(chalk.gray(`💡 Log: ${logPath}\n`));
  process.exit(0);
}

/** Tray mode: start server + system tray, no terminal UI */
async function startTrayMode() {
  let keyData = await ensureKeyData();

  const themeArg = process.argv.find(a => a.startsWith("--theme="));
  const theme = themeArg ? themeArg.split("=")[1] : null;

  const alreadyRunning = await isServerRunning();
  const serverManager = alreadyRunning
    ? { getProcess: () => null, shutdown: () => {} }
    : startServerWithRestart(null, null);

  if (!alreadyRunning) await new Promise(r => setTimeout(r, 2000));

  const uiUrl = `http://localhost:${SERVER_PORT}`;

  let activeTunnel = null;
  await pushUiState({ permanentKey: keyData.key, step: STEP.STOPPED, theme });

  const cleanup = () => {
    serverManager.shutdown();
    killProcessOnPort(SERVER_PORT);
    killTray();
  };

  setupExitHandler(serverManager, null, keyData.key);
  setupCmdPoller(() => activeTunnel, (t) => { activeTunnel = t; }, keyData.key);

  if (process.argv.includes("--start")) writeCmd("start-tunnel");

  await initTray({
    port: SERVER_PORT,
    onQuit: cleanup,
    onOpenUI: () => openBrowser(uiUrl),
  });

  await new Promise(() => {});
}

/** UI mode (9remote ui): start server + open browser, no tray */
async function startUiMode() {
  showBanner(getVersion());
  let keyData = await ensureKeyData();

  const themeArg = process.argv.find(a => a.startsWith("--theme="));
  const theme = themeArg ? themeArg.split("=")[1] : null;

  const alreadyRunning = await isServerRunning();
  const serverManager = alreadyRunning
    ? { getProcess: () => null, shutdown: () => {} }
    : startServerWithRestart(null, null);

  if (!alreadyRunning) await new Promise(r => setTimeout(r, 2000));

  const uiUrl = `http://localhost:${SERVER_PORT}`;
  console.log(chalk.green(`\n🌐 UI ready at ${uiUrl}`));

  let activeTunnel = null;
  await pushUiState({ permanentKey: keyData.key, step: STEP.STOPPED, theme });

  setupExitHandler(serverManager, null, keyData.key);
  setupCmdPoller(() => activeTunnel, (t) => { activeTunnel = t; }, keyData.key);

  if (process.argv.includes("--start")) writeCmd("start-tunnel");

  await new Promise(() => {});
}

// Start app
async function start() {
  const command = process.argv[2];
  
  if (command === "ui") {
    await startUiMode();
  } else if (command === "start" || process.argv.includes("--auto")) {
    await autoStartDev();
  } else if (process.argv.includes("--tray")) {
    await startTrayMode();
  } else {
    await startupMenu();
  }
}

async function startupMenu() {
  const version = getVersion();
  const updateInfo = await checkLatestVersion();
  const banner = getBannerText(version, updateInfo?.latest ?? null);

  const items = [];
  if (updateInfo?.latest) {
    items.push({ label: chalk.yellow(`Update to v${updateInfo.latest}`), action: "update" });
  }
  items.push(
    { label: "Open Web UI (background)", action: "ui" },
    { label: "Terminal UI", action: "tui" },
    { label: chalk.gray("Exit"), action: "exit" },
  );

  const idx = await selectMenu("", items, 0, banner);
  const action = idx >= 0 ? items[idx].action : "exit";

  if (action === "update") {
    const w = Math.min(44, process.stdout.columns || 44);
    // Stop running background instances so npm install can overwrite locked files
    stopRunningInstances();
    console.log(ORANGE("\n" + "═".repeat(w)));
    console.log(chalk.gray("  ✓ Stopped running instances\n"));
    console.log(chalk.yellow("  ⬆  Run this command to update:\n"));
    console.log(chalk.white.bold(`     npm i -g 9remote@latest\n`));
    console.log(ORANGE("═".repeat(w)) + "\n");
    process.exit(0);
  } else if (action === "ui") {
    await launchBackground();
  } else if (action === "tui") {
    await tuiMode();
  } else {
    process.exit(0);
  }
}

start().catch(console.error);
