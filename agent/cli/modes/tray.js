import { STEP } from "../../lib/constants.js";
import { writeCmd, loadSettings } from "../utils/state.js";
import { writePid, clearPid } from "../utils/pids.js";
import { initTray, openBrowser, showTrayNotification } from "../utils/tray.js";
import { isServerRunning, pushUiState } from "../core/localApi.js";
import { startServerWithRestart, setupExitHandler, shutdownAll } from "../core/lifecycle.js";
import { setupCmdPoller } from "../core/cmdPoller.js";
import { ensureKeyData } from "../session/key.js";
import { refreshAutoStart } from "../utils/autostart.js";
import { SERVER_PORT } from "../../lib/constants.js";
import { DELAYS } from "../config.js";

export async function startTrayMode() {
  // Record PID — this process holds dist/cli.cjs open; updater needs to kill it
  writePid("agent", process.pid);

  // Self-heal autostart entry after update: rewrite only if path/args drifted (no-op otherwise)
  refreshAutoStart().catch(() => {});

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
  setupCmdPoller(() => activeTunnel, (t) => { activeTunnel = t; }, keyData.key, () => serverManager);

  try { clearPid("cloudflared"); } catch {}

  const shouldStart = (process.argv.includes("--start") || process.argv.includes("--skip-update"))
    && loadSettings().remoteEnabled !== false;
  if (shouldStart) writeCmd("start-tunnel");

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
