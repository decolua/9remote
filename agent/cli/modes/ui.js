import chalk from "chalk";
import { STEP, SERVER_PORT } from "../../lib/constants.js";
import { writeCmd, loadSettings } from "../utils/state.js";
import { writePid } from "../utils/pids.js";
import { isServerRunning, pushUiState } from "../core/localApi.js";
import { startServerWithRestart, setupExitHandler, shutdownAll } from "../core/lifecycle.js";
import { setupCmdPoller } from "../core/cmdPoller.js";
import { showBanner } from "../utils/tui.js";
import { markRemoteOffline } from "../tunnel/urlSync.js";
import { initTray, killTray, openBrowser, updateTrayTooltip } from "../utils/tray.js";
import { killCloudflared } from "../utils/cloudflared.js";
import { ensureKeyData, getVersion } from "../session/key.js";
import { DELAYS } from "../config.js";

export async function startUiMode() {
  // A server that already answers belongs to another CLI — a second one would only
  // steal the pid file and race the owner's poller. Check twice: a server caught
  // mid-shutdown (restart_agent kills the tree, then spawns us) must not read as
  // alive, or nobody would be left serving.
  if (await isServerRunning()) {
    await new Promise((r) => setTimeout(r, DELAYS.guestRecheckMs));
    if (await isServerRunning()) {
      console.log(chalk.green(`\n🌐 UI already served at http://localhost:${SERVER_PORT}`));
      return;
    }
  }

  writePid("agent", process.pid);
  showBanner(getVersion());
  const keyData = await ensureKeyData();

  const themeArg = process.argv.find((a) => a.startsWith("--theme="));
  const theme = themeArg ? themeArg.split("=")[1] : null;

  // Orphans from a dead run: leftover tunnels (pid file + by-port) — the port
  // itself is swept by spawnServer's first start. Same boot contract as auto
  // mode, safe because no other agent answered the guest guard above.
  try { killCloudflared(); await new Promise((r) => setTimeout(r, DELAYS.killCloudflaredMs)); } catch {}

  const serverManager = startServerWithRestart(null, null);
  await new Promise((r) => setTimeout(r, DELAYS.serverBootMs));

  const uiUrl = `http://localhost:${SERVER_PORT}`;
  console.log(chalk.green(`\n🌐 UI ready at ${uiUrl}`));

  let activeTunnel = null;
  // Remote off at boot (or a crash left agentOnline=1 behind) — say goodbye so
  // login stops handing out this key instead of waiting out the grace window.
  if (loadSettings().remoteEnabled === false) await markRemoteOffline(keyData.key);
  await pushUiState({ permanentKey: keyData.key, step: STEP.STOPPED, theme });

  setupExitHandler(serverManager, null);
  setupCmdPoller(() => activeTunnel, (t) => { activeTunnel = t; }, keyData.key, () => serverManager);

  // Standalone `9remote ui` (no Tauri shell) gets a tray too; initTray skips
  // itself under NREMOTE_DESKTOP because the desktop app owns its own tray.
  await initTray({
    port: SERVER_PORT,
    onQuit: () => {
      const tunnel = activeTunnel;
      activeTunnel = null;
      shutdownAll({ serverManager, tunnelProcess: tunnel, exit: false });
      killTray();
      setTimeout(() => process.exit(0), 500);
    },
    onOpenUI: () => openBrowser(uiUrl),
  });
  updateTrayTooltip({ tunnelUrl: "", running: true });

  const shouldStart = (process.argv.includes("--start") || process.argv.includes("--skip-update"))
    && loadSettings().remoteEnabled !== false;
  if (shouldStart) writeCmd("start-tunnel");

  await new Promise(() => {});
}
