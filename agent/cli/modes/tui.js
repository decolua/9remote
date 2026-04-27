import chalk from "chalk";
import readline from "readline";
import { browserFetch, SERVER_PORT, STEP, LOG_TAIL_LINES } from "../../lib/constants.js";
import { LOG_FILE_PATH, readRecentLogs, createLogger } from "../../lib/logger.js";

const logger = createLogger("mode");
import { saveState, saveKey } from "../utils/state.js";
import { ensureCloudflared, killCloudflared } from "../utils/cloudflared.js";
import { updateTunnelHealthUrl } from "../utils/tunnelHealth.js";
import { selectMenu, confirm as tuiConfirm, subscribeSSE, openPermissionPane, showDeviceApproval, resetProgress } from "../utils/tui.js";
import { createTempKey } from "../utils/token.js";
import { getConsistentMachineId } from "../utils/machineId.js";
import { generateApiKeyWithMachine } from "../utils/apiKey.js";
import {
  apiGet, apiPost, pushUiState, setStep, onBinaryProgress,
  isServerRunning, fetchServerState, setTuiActive,
} from "../core/localApi.js";
import { startServerWithRestart, setupExitHandler, shutdownAll } from "../core/lifecycle.js";
import { setupCmdPoller } from "../core/cmdPoller.js";
import { spawnQuickTunnelWithRetry, makeTunnelRestartHandler } from "../tunnel/manager.js";
import { updateTunnelUrl } from "../tunnel/urlSync.js";
import { waitForTunnelReady } from "../tunnel/readiness.js";
import { ensureKeyData } from "../session/key.js";
import { buildMenuHeader } from "../session/display.js";
import { WORKER_URL, DELAYS, TUI, POLL } from "../config.js";

let activeSubmenuRefresh = null;

export async function tuiMode() {
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
      body: JSON.stringify({ apiKey: keyData.key }),
    });
    if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
  } catch (err) {
    logger.error(`❌ Failed to connect: ${err.message}`);
    process.exit(1);
  }

  await setStep(STEP.TUNNELING);

  let tunnelProcess, tunnelUrl;
  const tunnelRef = { current: null };
  const onUrlUpdate = async (newUrl) => {
    await updateTunnelUrl(keyData.key, newUrl);
    await pushUiState({ tunnelUrl: newUrl });
    updateTunnelHealthUrl(newUrl);
  };
  try {
    const result = await spawnQuickTunnelWithRetry(
      SERVER_PORT,
      onUrlUpdate,
      makeTunnelRestartHandler({ onUrlUpdate, setTunnel: (c) => { tunnelRef.current = c; } }),
    );
    tunnelProcess = result.child;
    tunnelUrl = result.tunnelUrl;
    tunnelRef.current = tunnelProcess;
  } catch (err) {
    logger.error(`❌ Tunnel failed: ${err.message}`);
    process.exit(1);
  }

  await setStep(STEP.VERIFYING);
  if (!(await waitForTunnelReady(tunnelUrl))) {
    logger.warn("⚠️  Tunnel health check timed out, proceeding anyway...");
  }

  await updateTunnelUrl(keyData.key, tunnelUrl);
  saveState({ apiKey: keyData.key, tunnelUrl, tunnelPid: tunnelProcess.pid });

  const tempKeyData = await createTempKey(keyData.key, WORKER_URL);
  const connectUrl = tempKeyData ? `${WORKER_URL}/login?k=${tempKeyData.tempKey}` : `${WORKER_URL}/login`;

  await setStep(STEP.READY, {
    tunnelUrl,
    oneTimeKey: tempKeyData?.tempKey || "",
    oneTimeKeyExpiresAt: tempKeyData?.expiresAt || null,
    permanentKey: keyData.key,
    qrUrl: connectUrl,
    workerUrl: WORKER_URL,
  });
  await new Promise((r) => setTimeout(r, DELAYS.trayReadyMs));

  let currentOneTimeKey = tempKeyData?.tempKey || "";
  let currentConnectUrl = connectUrl;
  let currentTunnelUrl = tunnelUrl;

  let menuHeader = await buildMenuHeader(currentOneTimeKey, keyData.key, currentConnectUrl, currentTunnelUrl);
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
      if (!deviceApprovalBusy) activeSubmenuRefresh?.();
      safeRedraw();
    } else if (type === "deviceApproval" && data.action === "pending") {
      await handlePendingApproval(data.socketId, data.deviceId, data.ip);
    }
  });

  // Fallback: recover from missed SSE pending events
  const pendingPoll = setInterval(async () => {
    if (deviceApprovalBusy) return;
    const d = await apiGet("/api/device/pending");
    const first = d?.pending?.[0];
    if (first) await handlePendingApproval(first.socketId, first.deviceId, first.ip);
  }, POLL.pendingApprovalMs);

  setupExitHandler({
    getProcess: tuiServerMgr.getProcess,
    shutdown: () => { tuiServerMgr.shutdown(); stopSSE(); clearInterval(pendingPoll); },
  }, tunnelProcess);

  setupCmdPoller(() => tunnelRef.current, (t) => { tunnelRef.current = t; }, keyData.key);

  const onShutdown = () => {
    try { stopSSE(); } catch {}
    try { clearInterval(pendingPoll); } catch {}
    shutdownAll({ serverManager: tuiServerMgr, tunnelProcess, exit: false });
  };

  await tuiMenuLoop(
    keyData, tunnelUrl,
    () => menuHeader,
    (h) => { menuHeader = h; },
    (cb) => { triggerMenuRedraw = cb; },
    onShutdown,
    logBuffer,
  );
}

async function tuiMenuLoop(keyData, tunnelUrl, getHeader, setHeader, onRedrawRegister, onCtrlC, logBuffer) {
  while (true) {
    const { desktopEnabled: desktopOn, remoteAvailable, autoApprove, autoStart } = await fetchServerState();

    const items = [
      { label: "Open Web UI", action: "webui" },
      { label: "Keys  \u25b6", action: "keys" },
    ];
    if (remoteAvailable) {
      items.push({ label: `Remote Desktop: ${desktopOn ? chalk.green("ON") : chalk.gray("OFF")}  ▶`, action: "desktop" });
    }
    items.push(
      { label: `Manage Devices  \u25b6  ${chalk.dim("(Auto-approve:")} ${autoApprove ? chalk.green("ON") : chalk.gray("OFF")}${chalk.dim(")")}`, action: "devices" },
      { label: `Launch on system startup: ${autoStart ? chalk.green("ON") : chalk.gray("OFF")}`, action: "autostart" },
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
    } else if (action === "autostart") {
      await apiPost("/api/autostart", { enabled: !autoStart });
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
      const newConnectUrl = `${WORKER_URL}/login?k=${newTempKey.tempKey}`;
      setHeader(await buildMenuHeader(newTempKey.tempKey, keyData.key, newConnectUrl, tunnelUrl));
      await pushUiState({ oneTimeKey: newTempKey.tempKey, oneTimeKeyExpiresAt: newTempKey.expiresAt, qrUrl: newConnectUrl });
    }
  } else if (action === "regen") {
    const confirmed = await tuiConfirm(chalk.yellow("⚠️  Replace current key and disconnect all sessions? Continue?"));
    if (confirmed) {
      const machineId = await getConsistentMachineId();
      const { key } = generateApiKeyWithMachine(machineId);
      const next = saveKey(machineId, key, keyData.name || "Default");
      Object.assign(keyData, next);
      await pushUiState({ permanentKey: keyData.key });
      const newTmp = await createTempKey(keyData.key, WORKER_URL);
      if (newTmp) {
        const newUrl = `${WORKER_URL}/login?k=${newTmp.tempKey}`;
        setHeader(await buildMenuHeader(newTmp.tempKey, keyData.key, newUrl, tunnelUrl));
        await pushUiState({ oneTimeKey: newTmp.tempKey, oneTimeKeyExpiresAt: newTmp.expiresAt, qrUrl: newUrl });
      }
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
