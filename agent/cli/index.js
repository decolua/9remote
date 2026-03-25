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
import { loadKey, saveKey, loadState, saveState, clearState, readAndClearCmd } from "./utils/state.js";
import { createTempKey } from "./utils/token.js";
import { checkAndUpdate, checkLatestVersion } from "./utils/updateChecker.js";
import { spawnQuickTunnel, killCloudflared, resetRestartCounter, ensureCloudflared } from "./utils/cloudflared.js";
import { showBanner, renderProgress, resetProgress, selectMenu, confirm as tuiConfirm, subscribeSSE, openPermissionPane } from "./utils/tui.js";
import { checkPermissions } from "./utils/permissions.js";

// Parse --skip-update flag
const skipUpdate = process.argv.includes("--skip-update");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
// When bundled (dist/cli.cjs), server.cjs is in same dist/ folder
// When dev (server/cli/index.js), use server/index.js directly
const STANDALONE_SERVER = path.resolve(__dirname, "../dist/server.cjs");
const DEV_SERVER = path.resolve(__dirname, "../index.js");
const WORKER_URL = "https://9remote.cc";
const SERVER_PORT = 2208;
const MAX_RESTART_ATTEMPTS = 10;
const RESTART_WINDOW_MS = 60000; // 1 minute

// Orange color from gitbook (#E68A6E)
const ORANGE = chalk.rgb(230, 138, 110);
const ORANGE_DIM = chalk.rgb(200, 120, 95);

/**
 * Get current version from package.json
 */
function getVersion() {
  // When bundled, version is injected at build time
  if (typeof __CLI_VERSION__ !== "undefined") {
    return __CLI_VERSION__;
  }
  
  // Dev mode: read from package.json
  try {
    const packagePath = path.join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    return packageJson.version;
  } catch {
    return "unknown";
  }
}


/**
 * Helper: Show QR code for connect URL
 */
function showQRCode(url, title = "📱 Scan QR to connect:") {
  console.log(ORANGE(`\n${title}`));
  qrcode.generate(url, { small: true, type: "terminal", margin: 0 }, (qr) => {
    console.log(qr.trim());
  });
}

/** Build QR block as string (for use in headerContent) */
function buildQRString(url) {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true, type: "terminal", margin: 0 }, (qr) => {
      resolve(ORANGE_DIM("📱 Scan QR to connect:") + "\n" + qr.trim());
    });
  });
}

/**
 * Helper: Show connection info
 */
async function showConnectionInfo(selectedKey, tunnelUrl) {
  const tempKeyData = await createTempKey(selectedKey, WORKER_URL);
  
  if (!tempKeyData) {
    console.log(chalk.red("❌ Failed to create temp key"));
    return;
  }

  const connectUrl = `${WORKER_URL}/login?k=${tempKeyData.tempKey}`;
  const width = Math.min(44, process.stdout.columns || 55);

  // Push ready state to UI (include permanentKey, expiresAt, workerUrl for server-side key generation)
  pushUiState({
    step: 4,
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
  
  // App URL
  const appLabel = "App URL";
  const appValue = `${WORKER_URL}/login`;
  console.log(chalk.white(appLabel.padEnd(14)) + chalk.gray(appValue));
  
  // One-Time Key
  const keyLabel = "One-Time Key";
  const keyValue = tempKeyData.tempKey;
  console.log(chalk.white(keyLabel.padEnd(14)) + ORANGE.bold(keyValue));
  
  // Permanent Key
  const permLabel = "Key";
  const permValue = selectedKey;
  console.log(chalk.white(permLabel.padEnd(14)) + chalk.gray(permValue));
  
  console.log(ORANGE("═".repeat(width)));
}

/**
 * Build full header string: QR + keys info (for selectMenu headerContent)
 */
async function buildMenuHeader(oneTimeKey, permanentKey, connectUrl) {
  const w = Math.min(44, process.stdout.columns || 44);
  const qrBlock = await buildQRString(connectUrl);
  const lines = [
    qrBlock,
    chalk.gray("\nQR expires in 30 minutes (one-time use)\n"),
    ORANGE("═".repeat(w)),
    chalk.white("App URL".padEnd(14))       + chalk.gray(`${WORKER_URL}/login`),
    chalk.white("One-Time Key".padEnd(14))  + ORANGE.bold(oneTimeKey),
    chalk.white("Key".padEnd(14))           + chalk.dim(permanentKey),
    ORANGE("═".repeat(w)),
  ];
  return lines.join("\n");
}

/**
 * Kill process on specific port
 */
function killProcessOnPort(port) {
  try {
    if (process.platform === "win32") {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`, { stdio: "ignore" });
    } else {
      const nullDevice = "/dev/null";
      execSync(`lsof -ti:${port} | xargs kill -9 2>${nullDevice} || true`, { stdio: "ignore" });
    }
  } catch { }
}

/**
 * Start server with auto-restart on crash
 */
function startServerWithRestart(onReady, onServerCrash) {
  const restartTimes = [];
  let currentProcess = null;
  let isShuttingDown = false;
  let isFirstStart = true;

  const spawnServer = () => {
    // Only kill port on first start, not on restart
    if (isFirstStart) {
      killProcessOnPort(SERVER_PORT);
      isFirstStart = false;
    } else {
    }

    // Use dev server if exists (development), otherwise use standalone (npm package)
    const useDevServer = process.env.NODE_ENV === "development" && fs.existsSync(DEV_SERVER);
    const serverPath = useDevServer ? DEV_SERVER : STANDALONE_SERVER;
    
    if (!fs.existsSync(serverPath)) {
      console.error(`❌ Server not found: ${serverPath}`);
      process.exit(1);
    }
    
    // Strip NODE_ENV=development when running standalone server (production build)
    const spawnEnv = { ...process.env, PORT: String(SERVER_PORT) };
    if (!useDevServer) delete spawnEnv.NODE_ENV;

    currentProcess = spawn("node", [serverPath], {
      cwd: path.dirname(serverPath),
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
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
        
        // Remove old restart times outside window
        while (restartTimes.length > 0 && restartTimes[0] < now - RESTART_WINDOW_MS) {
          restartTimes.shift();
        }

        if (restartTimes.length > MAX_RESTART_ATTEMPTS) {
          console.log(chalk.red(`❌ Too many restarts (${MAX_RESTART_ATTEMPTS} in ${RESTART_WINDOW_MS / 1000}s). Giving up.`));
          process.exit(1);
        }

        console.log(chalk.yellow(`🔄 Restarting server... (attempt ${restartTimes.length}/${MAX_RESTART_ATTEMPTS})`));
        console.log(ORANGE_DIM("⚠️  [DEBUG] NOTE: Tunnel connection may be stale - will restart tunnel"));
        
        // ✅ Callback để restart cloudflared
        if (onServerCrash) {
          console.log(chalk.yellow("✅ Restarting tunnel connection..."));
          onServerCrash();
        }
        
        // Wait a bit before restart
        setTimeout(() => {
          spawnServer();
        }, 1000);
      } else {
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

/**
 * Helper: Setup exit handler for server processes
 */
let exitHandlerRegistered = false;

function setupExitHandler(serverManager, tunnelProcess, apiKey) {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  
  process.on("SIGINT", async () => {
    console.log(chalk.yellow("\n\n🛑 Stopping server..."));
    
    serverManager.shutdown();
    if (tunnelProcess) tunnelProcess.kill();
    resetRestartCounter();
    clearState();
    
    console.log(chalk.green("✅ Server stopped"));
    process.exit(0);
  });
}

/**
 * Get first non-internal LAN IPv4 address
 */
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

/** Push UI state to server via HTTP */
async function pushUiState(data) {
  try {
    await fetch(`http://localhost:${SERVER_PORT}/api/ui/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch { /* server may not be ready yet */ }
}

/**
 * Update session tunnelUrl on worker + push to UI
 */
async function updateTunnelUrl(selectedKey, tunnelUrl) {
  const lanIp = getLanIp();
  try {
    await fetch(`${WORKER_URL}/api/session/update`, {
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

/**
 * Helper: Start server and quick tunnel
 */
async function startServerAndTunnel(selectedKey) {
  console.log(ORANGE("\n🚀 Starting server..."));
  pushUiState({ step: 1 });

  // Kill existing cloudflared process
  try {
    killCloudflared();
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch { }

  // Create session on worker
  try {
    const sessionResponse = await fetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: selectedKey })
    });
    if (!sessionResponse.ok) {
      const text = await sessionResponse.text();
      console.log(chalk.red(`❌ Failed to create session: ${sessionResponse.status} ${text.substring(0, 200)}`));
      return null;
    }
  } catch (error) {
    console.log(chalk.red(`❌ Failed to create session: ${error.message}`));
    return null;
  }

  // Skip spawning server if already running (e.g. nodemon in dev mode)
  const alreadyRunning = await isServerRunning();
  const serverManager = alreadyRunning
    ? { getProcess: () => null, shutdown: () => {} }
    : startServerWithRestart(null, null);

  if (!alreadyRunning) await new Promise(resolve => setTimeout(resolve, 2000));

  console.log(ORANGE("✅ Starting tunnel..."));
  pushUiState({ step: 2 });

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


/**
 * TUI mode — main flow for `9remote` (no subcommand)
 */
async function tuiMode() {
  console.clear();

  // ── 1. Parallel: check latest version + start server ──────────────────────
  const machineId = await getConsistentMachineId();
  let keyData = loadKey();
  if (!keyData.key) {
    const { key } = generateApiKeyWithMachine(machineId);
    keyData = saveKey(machineId, key, "Default");
  }

  // Run update check & server start in parallel
  const [updateInfo] = await Promise.all([
    checkLatestVersion(),
    (async () => {
      const alreadyRunning = await isServerRunning();
      if (!alreadyRunning) {
        startServerWithRestart(null, null);
        await new Promise((r) => setTimeout(r, 2000));
      }
    })(),
  ]);

  // ── 2. Show banner (with update notice if available) ──────────────────────
  const version = getVersion();
  showBanner(version, updateInfo?.latest ?? null);

  // ── 3. Progress: Preparing → Connecting → Tunneling → Ready ──────────────
  resetProgress();
  renderProgress(0); // Preparing

  // Kill stale cloudflared
  try { killCloudflared(); await new Promise((r) => setTimeout(r, 300)); } catch {}

  // Step 1 — Preparing (ensureCloudflared)
  await ensureCloudflared();

  renderProgress(1, true); // Connecting

  // Step 2 — Connecting (create session)
  try {
    const res = await fetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: keyData.key }),
    });
    if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
  } catch (err) {
    console.log(chalk.red(`\n❌ Failed to connect: ${err.message}`));
    process.exit(1);
  }

  renderProgress(2, true); // Starting tunnel

  // Step 3 — Tunnel
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

  await updateTunnelUrl(keyData.key, tunnelUrl);
  saveState({ apiKey: keyData.key, tunnelUrl, tunnelPid: tunnelProcess.pid });

  // ── 4. Create temp key + push ready state ─────────────────────────────────
  const tempKeyData = await createTempKey(keyData.key, WORKER_URL);
  const connectUrl = tempKeyData
    ? `${WORKER_URL}/login?k=${tempKeyData.tempKey}`
    : `${WORKER_URL}/login`;

  await pushUiState({
    step: 4,
    tunnelUrl,
    oneTimeKey: tempKeyData?.tempKey || "",
    oneTimeKeyExpiresAt: tempKeyData?.expiresAt || null,
    permanentKey: keyData.key,
    qrUrl: connectUrl,
    workerUrl: WORKER_URL,
  });

  // ── 5. Load initial state from server ────────────────────────────────────
  let currentOneTimeKey = tempKeyData?.tempKey || "";
  let currentConnectUrl = connectUrl;

  // ── 6. Build initial header ───────────────────────────────────────────────
  let menuHeader = await buildMenuHeader(currentOneTimeKey, keyData.key, currentConnectUrl);

  // Mutable ref for menu re-render callback (set by selectMenu)
  let triggerMenuRedraw = null;

  // ── 7. Subscribe SSE — auto-rebuild header on state changes ──────────────
  const stopSSE = subscribeSSE(SERVER_PORT, async (type, data) => {
    if (type === "state") {
      const newKey = data.permanentKey || keyData.key;
      const newOtk = data.oneTimeKey || currentOneTimeKey;
      const newUrl = data.qrUrl || currentConnectUrl;
      if (newOtk !== currentOneTimeKey || newKey !== keyData.key) {
        currentOneTimeKey = newOtk;
        currentConnectUrl = newUrl;
        if (data.permanentKey) keyData = { ...keyData, key: data.permanentKey };
        menuHeader = await buildMenuHeader(currentOneTimeKey, keyData.key, currentConnectUrl);
        triggerMenuRedraw?.();
      }
    } else if (type === "permissions") {
      // desktopEnabled changed — trigger redraw so menu label refreshes
      triggerMenuRedraw?.();
    }
  });

  setupExitHandler({ getProcess: () => null, shutdown: () => { stopSSE(); } }, tunnelProcess, keyData.key);

  // ── 8. Interactive menu loop ───────────────────────────────────────────────
  await tuiMenuLoop(
    keyData, tunnelUrl,
    () => menuHeader,
    (h) => { menuHeader = h; },
    (cb) => { triggerMenuRedraw = cb; }
  );
}

/** Fetch desktopEnabled from server (source of truth) */
async function fetchDesktopEnabled() {
  try {
    const res = await fetch(`http://localhost:${SERVER_PORT}/api/ui/state`);
    if (res.ok) { const d = await res.json(); return !!d.desktopEnabled; }
  } catch {}
  return false;
}

/**
 * Main menu loop after Ready.
 * @param {object} keyData
 * @param {string} tunnelUrl
 * @param {() => string} getHeader - live header getter (SSE may update it)
 * @param {(newHeader: string) => void} setHeader - update header from inside loop
 * @param {(cb: () => void) => void} onRedrawRegister - register redraw callback
 */
async function tuiMenuLoop(keyData, tunnelUrl, getHeader = () => "", setHeader = () => {}, onRedrawRegister = () => {}) {
  while (true) {
    const desktopOn = await fetchDesktopEnabled();
    const desktopLabel = `Remote Desktop: ${desktopOn ? chalk.green("ON") : chalk.gray("OFF")}  ▶`;
    const items = [
      { label: "Open UI" },
      { label: "New One-Time Key" },
      { label: "Regenerate Key" },
      { label: desktopLabel },
      { label: chalk.gray("Exit") },
    ];

    // Register SSE-triggered redraw with selectMenu
    let redrawMenu = null;
    onRedrawRegister(() => redrawMenu?.());

    const idx = await selectMenu("Select action", items, 0, getHeader(), (setRedraw) => {
      redrawMenu = setRedraw;
    });

    if (idx === 0) {
      // Open UI
      const url = `http://localhost:${SERVER_PORT}`;
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
      console.log(chalk.green(`\n🌐 Opening ${url}\n`));

    } else if (idx === 1) {
      // New One-Time Key — rebuild header with fresh QR
      const newTempKey = await createTempKey(keyData.key, WORKER_URL);
      if (newTempKey) {
        const newConnectUrl = `${WORKER_URL}/login?k=${newTempKey.tempKey}`;
        setHeader(await buildMenuHeader(newTempKey.tempKey, keyData.key, newConnectUrl));
        await pushUiState({ oneTimeKey: newTempKey.tempKey, oneTimeKeyExpiresAt: newTempKey.expiresAt, qrUrl: newConnectUrl });
      }

    } else if (idx === 2) {
      // Regenerate Key
      const confirmed = await tuiConfirm(chalk.yellow("⚠️  Replace current key and disconnect all sessions? Continue?"));
      if (confirmed) {
        const machineId = await getConsistentMachineId();
        const { key } = generateApiKeyWithMachine(machineId);
        keyData = saveKey(machineId, key, keyData.name || "Default");
        await pushUiState({ permanentKey: keyData.key });
        // Rebuild header with new key
        const newTmp = await createTempKey(keyData.key, WORKER_URL);
        if (newTmp) {
          const newUrl = `${WORKER_URL}/login?k=${newTmp.tempKey}`;
          setHeader(await buildMenuHeader(newTmp.tempKey, keyData.key, newUrl));
          await pushUiState({ oneTimeKey: newTmp.tempKey, oneTimeKeyExpiresAt: newTmp.expiresAt, qrUrl: newUrl });
        }
      }

    } else if (idx === 3) {
      // Remote Desktop submenu
      await tuiDesktopMenu();

    } else {
      // Exit
      console.log(chalk.gray("\nGoodbye!\n"));
      process.exit(0);
    }
  }
}

/**
 * Remote Desktop submenu.
 * All state (desktopEnabled + permissions) fetched from server — no local tracking.
 */
async function tuiDesktopMenu() {
  while (true) {
    // Always read from server
    let desktopOn = false, perms = { screenRecording: false, accessibility: false };
    try {
      const res = await fetch(`http://localhost:${SERVER_PORT}/api/ui/state`);
      if (res.ok) {
        const d = await res.json();
        desktopOn = !!d.desktopEnabled;
        perms = { screenRecording: !!d.screenRecording, accessibility: !!d.accessibility };
      }
    } catch {}

    const toggleLabel = `Toggle: ${desktopOn ? chalk.green("ON  → turn OFF") : chalk.gray("OFF → turn ON")}`;
    const srLabel = `Screen Recording  ${perms.screenRecording ? chalk.green("✓") : chalk.red("✗ (click to grant)")}`;
    const axLabel = `Accessibility     ${perms.accessibility  ? chalk.green("✓") : chalk.red("✗ (click to grant)")}`;

    const idx = await selectMenu("Remote Desktop", [
      { label: toggleLabel },
      { label: srLabel },
      { label: axLabel },
      { label: chalk.gray("← Back") },
    ], 0);

    if (idx === 0) {
      // Toggle — flip current value via server
      try {
        await fetch(`http://localhost:${SERVER_PORT}/api/desktop/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !desktopOn }),
        });
      } catch {}

    } else if (idx === 1 && !perms.screenRecording) {
      try {
        await fetch(`http://localhost:${SERVER_PORT}/api/permissions/request`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "screenRecording" }),
        });
      } catch { openPermissionPane("screenRecording"); }

    } else if (idx === 2 && !perms.accessibility) {
      try {
        await fetch(`http://localhost:${SERVER_PORT}/api/permissions/request`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "accessibility" }),
        });
      } catch { openPermissionPane("accessibility"); }

    } else if (idx === 3 || idx === -1) {
      return; // Back
    }
  }
}


/**
 * Auto start dev server (--auto flag)
 */
async function autoStartDev() {
  showBanner(getVersion());

  const machineId = await getConsistentMachineId();
  let keyData = loadKey();

  // Auto create key if none exists
  if (!keyData.key) {
    console.log(chalk.yellow("⚠️  No key found. Creating default key..."));
    const { key } = generateApiKeyWithMachine(machineId);
    keyData = saveKey(machineId, key, "Default");
    console.log(chalk.green("✅ Default key created!"));
  }

  console.log(chalk.gray(`Using key: ${keyData.key.slice(0, 20)}... (${keyData.name})`));

  const result = await startServerAndTunnel(keyData.key);
  if (!result) {
    process.exit(1);
  }

  const { serverManager, tunnelProcess, tunnelUrl } = result;

  await showConnectionInfo(keyData.key, tunnelUrl);
  setupExitHandler(serverManager, tunnelProcess, keyData.key);
  setupKeyRegenListener();

  // Push stats to UI every 5s
  const startTime = Date.now();
  setInterval(() => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = uptime % 60;
    pushUiState({ uptime: `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` });
  }, 5000);

  // Keep process alive
  await new Promise(() => { });
}


/**
 * Listen for key regen, stop-tunnel, start-tunnel from server UI
 */
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
      await pushUiState({ step: 0, tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null });
    }

    if (cmd === "start-tunnel") {
      if (getActiveTunnel()) { busy = false; return; } // already running
      console.log(ORANGE("🚀 Starting tunnel..."));
      try {
        // Step 1: Preparing — check/download cloudflared binary
        await pushUiState({ step: 1 });
        await ensureCloudflared();

        // Step 2: Connecting — create session on worker
        await pushUiState({ step: 2 });
        const sessionResponse = await fetch(`${WORKER_URL}/api/session/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        if (!sessionResponse.ok) throw new Error(`Session create failed: ${sessionResponse.status}`);

        // Step 3: Tunneling — spawn cloudflared
        await pushUiState({ step: 3 });
        const result = await spawnQuickTunnel(SERVER_PORT, async (newUrl) => {
          await updateTunnelUrl(apiKey, newUrl);
          await pushUiState({ tunnelUrl: newUrl });
        });
        setActiveTunnel(result.child);
        await updateTunnelUrl(apiKey, result.tunnelUrl);

        // Step 4: Ready
        await showConnectionInfo(apiKey, result.tunnelUrl);
      } catch (err) {
        console.log(chalk.red(`❌ Failed to start tunnel: ${err.message}`));
        await pushUiState({ step: 0 });
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

/**
 * Check if server is already running on SERVER_PORT
 */
async function isServerRunning() {
  try {
    const res = await fetch(`http://localhost:${SERVER_PORT}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * UI mode: start server (if not running) + tunnel + open browser
 * Same as "Start Server" in TUI but auto-opens browser
 */
async function startUiMode() {
  showBanner(getVersion());

  const machineId = await getConsistentMachineId();
  let keyData = loadKey();

  if (!keyData.key) {
    const { key } = generateApiKeyWithMachine(machineId);
    keyData = saveKey(machineId, key, "Default");
  }

  // Start server only (no tunnel yet — wait for UI Connect button)
  const alreadyRunning = await isServerRunning();
  const serverManager = alreadyRunning
    ? { getProcess: () => null, shutdown: () => {} }
    : startServerWithRestart(null, null);

  if (!alreadyRunning) await new Promise(resolve => setTimeout(resolve, 2000));

  // Open browser pointing to UI
  const url = `http://localhost:${SERVER_PORT}`;
  const openCmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  spawn(openCmd, [url], { detached: true, stdio: "ignore" }).unref();
  console.log(chalk.green(`\n🌐 UI ready at ${url}`));

  // Mutable ref for active tunnel
  let activeTunnel = null;
  const getActiveTunnel = () => activeTunnel;
  const setActiveTunnel = (t) => { activeTunnel = t; };

  // Push permanentKey to UI so Welcome screen can display it
  await pushUiState({ permanentKey: keyData.key, step: 0 });

  setupExitHandler(serverManager, null, keyData.key);
  setupCmdPoller(getActiveTunnel, setActiveTunnel, keyData.key);

  await new Promise(() => { });
}

// Start app
async function start() {
  // Check and auto-update (exits if update started)
  const hasUpdate = await checkAndUpdate(skipUpdate);
  if (hasUpdate) return;
  
  const command = process.argv[2];
  
  if (command === "ui") {
    // UI mode: 9remote ui
    await startUiMode();
  } else if (command === "start" || process.argv.includes("--auto")) {
    // Direct start: 9remote start
    await autoStartDev();
  } else {
    // TUI mode: 9remote
    await tuiMode();
  }
}

start().catch(console.error);
