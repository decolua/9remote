import chalk from "chalk";
import { getHostPublicKeyB64, getHostX25519PublicKeyB64 } from "../../lib/hostKey.js";
import readline from "readline";
import { browserFetch, SERVER_PORT, STEP, LOG_TAIL_LINES } from "../../lib/constants.js";
import { LOG_FILE_PATH, readRecentLogs, createLogger } from "../../lib/logger.js";

const logger = createLogger("mode");
import { saveState, saveKey } from "../utils/state.js";
import { ensureCloudflared, killCloudflared, spawnQuickTunnel } from "../utils/cloudflared.js";
import { updateTunnelHealthUrl } from "../utils/tunnelHealth.js";
import { selectMenu, confirm as tuiConfirm, subscribeSSE, openPermissionPane, showDeviceApproval, resetProgress } from "../utils/tui.js";
import { createTempKey, connectUrlOf, registerSession } from "../utils/token.js";
import { getConsistentMachineId } from "../utils/machineId.js";
import { writePid } from "../utils/pids.js";
import { generateApiKeyV2, headOf } from "../utils/apiKey.js";
import {
  apiGet, apiPost, pushUiState, setStep, onBinaryProgress,
  isServerRunning, fetchServerState, setTuiActive,
} from "../core/localApi.js";
import { startServerWithRestart, setupExitHandler, shutdownAll } from "../core/lifecycle.js";
import { setupCmdPoller } from "../core/cmdPoller.js";
import { makeTunnelRestartHandler, startBackgroundTunnelReconnect, cancelActiveBgTunnel } from "../tunnel/manager.js";
import { waitForTunnelReady } from "../tunnel/readiness.js";
import { updateTunnelUrl } from "../tunnel/urlSync.js";
import { ensureKeyData } from "../session/key.js";
import { buildMenuHeader } from "../session/display.js";
import { WORKER_URL, DELAYS, TUI, POLL } from "../config.js";

let activeSubmenuRefresh = null;

export async function tuiMode() {
  writePid("agent", process.pid);
  console.clear();
  resetProgress();
  setTuiActive(true);
  await setStep(STEP.PREPARING);

  let keyData = await ensureKeyData();

  let triggerMenuRedraw = null;
  let tuiServerMgr = { getProcess: () => null, shutdown: () => {} };
  const alreadyRunning = await isServerRunning();
  if (!alreadyRunning) {
    tuiServerMgr = startServerWithRestart(null, null, () => {
      // Child exit can leave kernel TTY in cooked mode — toggle raw to force ioctl re-apply
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
        try { process.stdin.setRawMode(true); process.stdin.resume(); } catch {}
      }
      try { readline.emitKeypressEvents(process.stdin); } catch {}
      triggerMenuRedraw?.();
    });
    const deadline = Date.now() + POLL.serverReadyTimeoutMs;
    while (Date.now() < deadline && !(await isServerRunning())) {
      await new Promise((r) => setTimeout(r, POLL.serverReadyIntervalMs));
    }
  }

  try { killCloudflared(); await new Promise((r) => setTimeout(r, DELAYS.killCloudflaredTuiMs)); } catch {}

  await ensureCloudflared(onBinaryProgress);

  await setStep(STEP.CONNECTING);

  try {
    const res = await browserFetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: headOf(keyData.key), hostPublicKey: getHostPublicKeyB64(), hostX25519Key: getHostX25519PublicKeyB64() }),
    });
    if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
    // The row the DO gate needs now exists — revive a relay that gave up before it did.
    await apiPost("/api/signaling/retry", {});
  } catch (err) {
    logger.error(`Failed to connect: ${err.message}`);
    process.exit(1);
  }

  await setStep(STEP.TUNNELING);

  // tempKey first — connect URL is Worker-based, doesn't depend on the tunnel.
  // RTC signaling goes via the DO; the tunnel is a fallback transport.
  const tempKeyData = await createTempKey(keyData.key, WORKER_URL);
  const connectUrl = connectUrlOf(WORKER_URL, tempKeyData);

  let currentOneTimeKey = tempKeyData?.oneTimeKey || "";
  let currentConnectUrl = connectUrl;
  let currentTunnelUrl = "";
  let menuHeader = null;
  const tunnelRef = { current: null };
  const onTunnelUrl = async (newUrl) => {
    currentTunnelUrl = newUrl;
    await updateTunnelUrl(keyData.key, newUrl);
    await pushUiState({ tunnelUrl: newUrl });
    updateTunnelHealthUrl(newUrl);
    if (menuHeader !== null) {
      menuHeader = await buildMenuHeader(currentOneTimeKey, keyData.key, currentConnectUrl, currentTunnelUrl);
      triggerMenuRedraw?.();
    }
  };

  // Foreground: one spawn attempt. Fail or health-timeout → show QR (RTC-only)
  // + background reconnect. RTC signaling is already live (server child).
  let result = null;
  try {
    result = await spawnQuickTunnel(
      SERVER_PORT,
      onTunnelUrl,
      makeTunnelRestartHandler({ onUrlUpdate: onTunnelUrl, setTunnel: (c) => { tunnelRef.current = c; } }),
    );
  } catch (err) {
    logger.error(`Tunnel spawn failed: ${err?.message || err} — QR RTC-only, bg retry`);
  }
  if (result) {
    tunnelRef.current = result.child;
    currentTunnelUrl = result.tunnelUrl;
    saveState({ apiKey: keyData.key, tunnelUrl: result.tunnelUrl, tunnelPid: result.child?.pid });
    await setStep(STEP.VERIFYING);
    if (!(await waitForTunnelReady(result.tunnelUrl))) {
      logger.warn("Tunnel health check timed out — bg reconnect");
      tunnelRef.current = null;
      currentTunnelUrl = "";
      result = null;
    } else {
      await onTunnelUrl(result.tunnelUrl);
    }
  }
  if (!result) {
    startBackgroundTunnelReconnect(SERVER_PORT, {
      onUrlUpdate: onTunnelUrl,
      onRestart: makeTunnelRestartHandler({ onUrlUpdate: onTunnelUrl, setTunnel: (c) => { tunnelRef.current = c; } }),
      setActiveTunnel: (c) => { tunnelRef.current = c; },
      onReady: async (r) => {
        saveState({ apiKey: keyData.key, tunnelUrl: r.tunnelUrl, tunnelPid: r.child?.pid });
        await setStep(STEP.READY, { tunnelUrl: r.tunnelUrl });
      },
    });
  }

  await setStep(STEP.READY, {
    tunnelUrl: currentTunnelUrl,
    oneTimeKey: tempKeyData?.oneTimeKey || "",
    oneTimeKeyExpiresAt: tempKeyData?.expiresAt || null,
    permanentKey: keyData.key,
    qrUrl: connectUrl,
    workerUrl: WORKER_URL,
  });
  await new Promise((r) => setTimeout(r, DELAYS.trayReadyMs));

  menuHeader = await buildMenuHeader(currentOneTimeKey, keyData.key, currentConnectUrl, currentTunnelUrl);
  const logBuffer = [];
  let deviceApprovalBusy = false;

  // Skip redraws while approval prompt is on screen — SSE redraws would clear it
  const safeRedraw = () => { if (!deviceApprovalBusy) triggerMenuRedraw?.(); };

  const handlePendingApproval = async (socketId, deviceId, ip) => {
    if (deviceApprovalBusy) return;
    deviceApprovalBusy = true;
    try {
      const approved = await showDeviceApproval(deviceId, ip);
      await apiPost(`/api/device/${approved ? "approve" : "reject"}`, { socketId });
    } catch {} finally {
      deviceApprovalBusy = false;
      triggerMenuRedraw?.();
    }
  };

  const stopSSE = subscribeSSE(SERVER_PORT, async (type, data) => {
    if (type === "log" && data.message) {
      logBuffer.push(data.message);
      if (logBuffer.length > TUI.maxLogLines) logBuffer.shift();
    } else if (type === "state") {
      const newKey = data.permanentKey || keyData.key;
      // "" means cleared (one-time key consumed); undefined means preserve
      const newOtk = data.oneTimeKey !== undefined ? data.oneTimeKey : currentOneTimeKey;
      const newUrl = data.qrUrl !== undefined ? data.qrUrl : currentConnectUrl;
      const newTunnel = data.tunnelUrl !== undefined ? data.tunnelUrl : currentTunnelUrl;
      if (newOtk !== currentOneTimeKey || newKey !== keyData.key || newTunnel !== currentTunnelUrl) {
        currentOneTimeKey = newOtk;
        currentConnectUrl = newUrl;
        currentTunnelUrl = newTunnel;
        if (data.permanentKey) keyData = { ...keyData, key: data.permanentKey };
        menuHeader = await buildMenuHeader(currentOneTimeKey, keyData.key, currentConnectUrl, currentTunnelUrl);
        safeRedraw();
      }
    } else if (type === "permissions") {
      // refresh is async — a rejection here would escape and kill the CLI parent
      if (!deviceApprovalBusy) Promise.resolve(activeSubmenuRefresh?.()).catch(() => {});
      safeRedraw();
    } else if (type === "autostart" || type === "sleepInhibit") {
      // refresh is async — a rejection here would escape and kill the CLI parent
      if (!deviceApprovalBusy) Promise.resolve(activeSubmenuRefresh?.()).catch(() => {});
      safeRedraw();
    } else if (type === "deviceApproval" && data.action === "pending") {
      await handlePendingApproval(data.socketId, data.deviceId, data.ip);
    }
  });

  // Fallback: recover from missed SSE pending events
  const pendingPoll = setInterval(async () => {
    if (deviceApprovalBusy) return;
    // A throw here would surface as an unhandled rejection and take the CLI down
    try {
      const d = await apiGet("/api/device/pending");
      const first = d?.pending?.[0];
      if (first) await handlePendingApproval(first.socketId, first.deviceId, first.ip);
    } catch {}
  }, POLL.pendingApprovalMs);

  setupExitHandler({
    getProcess: tuiServerMgr.getProcess,
    shutdown: () => {
      cancelActiveBgTunnel();
      tuiServerMgr.shutdown();
      // tunnelRef.current is null until the background spawn resolves — read at
      // exit time so a late-arriving tunnel is still cleaned up.
      try { tunnelRef.current?.kill(); } catch {}
      stopSSE();
      clearInterval(pendingPoll);
    },
  });

  setupCmdPoller(() => tunnelRef.current, (t) => { tunnelRef.current = t; }, keyData.key, () => tuiServerMgr);

  const onShutdown = () => {
    cancelActiveBgTunnel();
    try { stopSSE(); } catch {}
    try { clearInterval(pendingPoll); } catch {}
    shutdownAll({ serverManager: tuiServerMgr, tunnelProcess: tunnelRef.current, exit: false });
  };

  await tuiMenuLoop(
    keyData, currentTunnelUrl,
    () => menuHeader,
    (h) => { menuHeader = h; },
    (cb) => { triggerMenuRedraw = cb; },
    onShutdown,
    logBuffer,
  );
}

async function tuiMenuLoop(keyData, tunnelUrl, getHeader, setHeader, onRedrawRegister, onCtrlC, logBuffer) {
  while (true) {
    const { desktopEnabled: desktopOn, remoteAvailable, autoApprove } = await fetchServerState();

    const items = [
      { label: "Open Web UI", action: "webui" },
      { label: "Keys  \u25b6", action: "keys" },
    ];
    if (remoteAvailable) {
      items.push({ label: `Remote Desktop: ${desktopOn ? chalk.green("ON") : chalk.gray("OFF")}  ▶`, action: "desktop" });
    }
    items.push(
      { label: `Manage Devices  \u25b6  ${chalk.dim("(Auto-approve:")} ${autoApprove ? chalk.green("ON") : chalk.gray("OFF")}${chalk.dim(")")}`, action: "devices" },
      { label: "Settings  \u25b6", action: "settings" },
      { label: "View Logs", action: "logs" },
      { label: chalk.gray("Exit"), action: "exit" },
    );

    let redrawMenu = null;
    onRedrawRegister(() => redrawMenu?.());

    const idx = await selectMenu("", items, 0, getHeader, (setRedraw) => { redrawMenu = setRedraw; }, onCtrlC);
    const action = idx >= 0 ? items[idx].action : "exit";

    if (action === "webui") {
      const url = `http://localhost:${SERVER_PORT}`;
      const { openBrowser } = await import("../utils/tray.js");
      openBrowser(url);
      console.log(chalk.green(`\n🌐 Opening ${url}\n`));
    } else if (action === "keys") {
      await tuiKeysMenu(keyData, tunnelUrl, setHeader, getHeader);
    } else if (action === "desktop") {
      await tuiDesktopMenu();
    } else if (action === "devices") {
      await tuiDevicesMenu();
    } else if (action === "settings") {
      await tuiSettingsMenu();
    } else if (action === "logs") {
      await tuiLogsView();
    } else {
      try { onCtrlC?.(); } catch {}
      console.log(chalk.gray("\nGoodbye!\n"));
      process.exit(0);
    }
  }
}

async function tuiKeysMenu(keyData, tunnelUrl, setHeader, getHeader) {
  const items = [
    { label: "New One-Time Key", action: "otk" },
    { label: "Regenerate Permanent Key", action: "regen" },
    { label: chalk.gray("← Back"), action: "back" },
  ];
  const ki = await selectMenu("Keys", items, 0, getHeader);
  const action = ki >= 0 ? items[ki].action : "back";

  if (action === "otk") {
    const newTempKey = await createTempKey(keyData.key, WORKER_URL);
    if (newTempKey) {
      const newConnectUrl = connectUrlOf(WORKER_URL, newTempKey);
      setHeader(await buildMenuHeader(newTempKey.oneTimeKey, keyData.key, newConnectUrl, tunnelUrl));
      await pushUiState({ oneTimeKey: newTempKey.oneTimeKey, oneTimeKeyExpiresAt: newTempKey.expiresAt, qrUrl: newConnectUrl });
    }
  } else if (action === "regen") {
    const confirmed = await tuiConfirm(chalk.yellow("Replace current key and disconnect all sessions? Continue?"));
    if (confirmed) {
      const machineId = await getConsistentMachineId();
      const key = generateApiKeyV2(machineId);
      // Register before storing — a key with no session row can never log in.
      if (!(await registerSession(key, WORKER_URL, tunnelUrl, keyData.key))) {
        setHeader(chalk.red("Key regeneration failed — could not reach the server"));
        return;
      }
      const next = saveKey(machineId, key, keyData.name || "Default");
      Object.assign(keyData, next);
      // Separate lifecycles: replacing this key does NOT mint a pairing code.
      // The old code is dropped (it redeems to the key just retired) and the QR
      // goes with it; "New One-Time Key" is how the user gets the next one.
      setHeader(await buildMenuHeader("", keyData.key, "", tunnelUrl));
      await pushUiState({ permanentKey: keyData.key, oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "", pairingUsed: true });
    }
  }
}

const SLEEP_MODE_LABELS = {
  "30m":   "Off after 30 min idle",
  "1h":    "Off after 1 hour idle",
  "2h":    "Off after 2 hours idle",
  "4h":    "Off after 4 hours idle",
  "24h":   "Off after 24 hours idle",
  "never": "Never off",
};

async function tuiSleepModeMenu(currentMode, presets) {
  const items = presets.map((m) => ({ label: SLEEP_MODE_LABELS[m] || m, action: m }));
  items.push({ label: chalk.gray("← Back"), action: "back" });
  const defaultIdx = Math.max(0, presets.indexOf(currentMode));
  const idx = await selectMenu("Prevent sleep", items, defaultIdx);
  const action = idx >= 0 ? items[idx].action : "back";
  if (action !== "back") await apiPost("/api/sleep-inhibit", { mode: action });
}

async function tuiSettingsMenu() {
  while (true) {
    let autoStart = false;
    let sleepMode = "never";
    let sleepPresets = [];

    const buildItems = () => [
      { label: `Launch on system startup: ${autoStart ? chalk.green("ON") : chalk.gray("OFF")}`, action: "autostart" },
      { label: `Prevent sleep:            ${chalk.green(SLEEP_MODE_LABELS[sleepMode] || sleepMode)}  ▶`, action: "sleep" },
      { label: chalk.gray("← Back"), action: "back" },
    ];

    let items = buildItems();
    let redrawMenu = null;
    const syncFromServer = async () => {
      const s = await fetchServerState();
      autoStart = !!s.autoStart;
      sleepMode = s.sleepInhibitMode || "never";
      sleepPresets = s.sleepInhibitPresets || [];
      items = buildItems();
      redrawMenu?.();
    };

    await syncFromServer();
    activeSubmenuRefresh = syncFromServer;
    const idx = await selectMenu("Settings", items, 0, "", (setRedraw) => { redrawMenu = setRedraw; });
    activeSubmenuRefresh = null;

    const action = idx >= 0 ? items[idx].action : "back";
    if (action === "autostart") {
      await apiPost("/api/autostart", { enabled: !autoStart });
    } else if (action === "sleep") {
      await tuiSleepModeMenu(sleepMode, sleepPresets);
    } else {
      return;
    }
  }
}

async function tuiDesktopMenu() {
  while (true) {
    let desktopOn = false;
    let perms = { screenRecording: false, accessibility: false };

    const buildLabels = () => ({
      toggle: `Toggle: ${desktopOn ? chalk.green("ON  → turn OFF") : chalk.gray("OFF → turn ON")}`,
      sr: `Screen Recording          ${perms.screenRecording ? chalk.green("✓") : chalk.red("✗ (click to grant)")}`,
      ax: `Mouse & Keyboard control  ${perms.accessibility ? chalk.green("✓") : chalk.red("✗ (click to grant)")}`,
    });

    const items = [{ label: "" }, { label: "" }, { label: "" }, { label: chalk.gray("← Back") }];

    let redrawMenu = null;
    const syncFromServer = async () => {
      const s = (await apiGet("/api/ui/state")) || {};
      desktopOn = !!s.desktopEnabled;
      perms = { screenRecording: !!s.screenRecording, accessibility: !!s.accessibility };
      const L = buildLabels();
      items[0].label = L.toggle;
      items[1].label = L.sr;
      items[2].label = L.ax;
      redrawMenu?.();
    };

    await syncFromServer();
    activeSubmenuRefresh = syncFromServer;
    const idx = await selectMenu("Remote Desktop", items, 0, "", (setRedraw) => { redrawMenu = setRedraw; });
    activeSubmenuRefresh = null;

    if (idx === 0) {
      await apiPost("/api/desktop/toggle", { enabled: !desktopOn });
    } else if (idx === 1 && !perms.screenRecording) {
      if (!(await apiPost("/api/permissions/request", { type: "screenRecording" }))) openPermissionPane("screenRecording");
    } else if (idx === 2 && !perms.accessibility) {
      if (!(await apiPost("/api/permissions/request", { type: "accessibility" }))) openPermissionPane("accessibility");
    } else if (idx === 3 || idx === -1) {
      return;
    }
  }
}

async function tuiDevicesMenu() {
  while (true) {
    const [approvedData, autoData] = await Promise.all([
      apiGet("/api/device/approved"),
      apiGet("/api/device/auto-approve"),
    ]);
    const devices = approvedData?.devices || [];
    const autoOn = !!autoData?.enabled;

    const items = [
      { label: `Auto-approve new devices: ${autoOn ? chalk.green("ON") : chalk.gray("OFF")}`, action: "toggle" },
      ...devices.map((d) => {
        const short = d.deviceId.slice(0, 8);
        const date = d.approvedAt ? new Date(d.approvedAt).toLocaleString() : "unknown";
        return { label: `${short}...  ${chalk.dim(date)}`, action: "remove", deviceId: d.deviceId };
      }),
      { label: chalk.gray("\u2190 Back"), action: "back" },
    ];

    const idx = await selectMenu(`Approved Devices (${devices.length})`, items, 0);
    if (idx === -1) return;
    const sel = items[idx];
    if (sel.action === "back") return;

    if (sel.action === "toggle") {
      await apiPost("/api/device/auto-approve", { enabled: !autoOn });
      continue;
    }
    if (sel.action === "remove") {
      const confirmed = await tuiConfirm(chalk.yellow(`Remove device ${sel.deviceId.slice(0, 8)}...?`));
      if (confirmed) await apiPost("/api/device/remove", { deviceId: sel.deviceId });
    }
  }
}

async function tuiLogsView() {
  const lines = readRecentLogs(LOG_TAIL_LINES);
  const body = lines.length ? lines.join("\n") : chalk.gray("  No logs yet");
  const footer = `\n${chalk.dim("Log file:")} ${chalk.cyan(LOG_FILE_PATH)}\n${chalk.dim(`Tail: tail -f ${LOG_FILE_PATH}`)}`;
  await selectMenu("Logs", [{ label: chalk.gray("← Back") }], 0, body + footer);
}
