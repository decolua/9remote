import { STEP } from "../../lib/constants.js";
import { writeCmd, loadState } from "../utils/state.js";
import { writePid, clearPid, readPid, isAlive } from "../utils/pids.js";
import { initTray, openBrowser, showTrayNotification } from "../utils/tray.js";
import { isServerRunning, pushUiState } from "../core/localApi.js";
import { startServerWithRestart, setupExitHandler, shutdownAll } from "../core/lifecycle.js";
import { setupCmdPoller } from "../core/cmdPoller.js";
import { adoptTunnel } from "../utils/cloudflared.js";
import { makeTunnelRestartHandler } from "../tunnel/manager.js";
import { updateTunnelUrl } from "../tunnel/urlSync.js";
import { updateTunnelHealthUrl } from "../utils/tunnelHealth.js";
import { saveState } from "../utils/state.js";
import { ensureKeyData } from "../session/key.js";
import { SERVER_PORT } from "../../lib/constants.js";
import { DELAYS } from "../config.js";

export async function startTrayMode() {
  // Record PID — this process holds dist/cli.cjs open; updater needs to kill it
  writePid("agent", process.pid);

  const keyData = await ensureKeyData();

  const themeArg = process.argv.find((a) => a.startsWith("--theme="));
  const theme = themeArg ? themeArg.split("=")[1] : null;

  const alreadyRunning = await isServerRunning();
  const serverManager = alreadyRunning
    ? { getProcess: () => null, shutdown: () => {} }
    : startServerWithRestart(null, null);

  if (!alreadyRunning) await new Promise((r) => setTimeout(r, DELAYS.serverBootMs));

  const uiUrl = `http://localhost:${SERVER_PORT}`;

  let activeTunnel = null;
  await pushUiState({ permanentKey: keyData.key, step: STEP.STOPPED, theme });

  const cleanup = () => {
    const tunnel = activeTunnel;
    activeTunnel = null;
    // Tray's onClick calls process.exit after this — don't double-exit
    shutdownAll({ serverManager, tunnelProcess: tunnel, exit: false });
  };

  setupExitHandler(serverManager, null);
  setupCmdPoller(() => activeTunnel, (t) => { activeTunnel = t; }, keyData.key);

  // After update we restart with --adopt-tunnel: reuse the surviving cloudflared
  // (same URL, no reconnect) instead of killing + respawning it.
  const cfPid = readPid("cloudflared");
  const canAdopt = process.argv.includes("--adopt-tunnel") && cfPid && isAlive(cfPid);

  if (canAdopt) {
    const prev = loadState();
    const url = prev?.tunnelUrl || "";
    const onUrlUpdate = async (newUrl) => {
      await updateTunnelUrl(keyData.key, newUrl);
      saveState({ apiKey: keyData.key, tunnelUrl: newUrl, tunnelPid: readPid("cloudflared") });
      await pushUiState({ tunnelUrl: newUrl });
      updateTunnelHealthUrl(newUrl);
    };
    const restart = makeTunnelRestartHandler({ onUrlUpdate, setTunnel: (c) => { activeTunnel = c; } });
    activeTunnel = adoptTunnel(url, restart);
    if (activeTunnel) {
      updateTunnelHealthUrl(url);
      await pushUiState({ step: STEP.READY, tunnelUrl: url });
    } else {
      writeCmd("start-tunnel"); // adopt failed → fresh start
    }
  } else {
    try { clearPid("cloudflared"); } catch {}
    if (process.argv.includes("--start")) writeCmd("start-tunnel");
  }

  const tray = await initTray({
    port: SERVER_PORT,
    onQuit: cleanup,
    onOpenUI: () => openBrowser(uiUrl),
  });

  if (tray) {
    showTrayNotification({
      title: "9Remote is running",
      message: `Open ${uiUrl} or use the tray icon to manage.`,
    });
  }

  await new Promise(() => {});
}
