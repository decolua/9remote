import chalk from "chalk";
import { STEP, SERVER_PORT } from "../../lib/constants.js";
import { writeCmd } from "../utils/state.js";
import { writePid } from "../utils/pids.js";
import { isServerRunning, pushUiState } from "../core/localApi.js";
import { startServerWithRestart, setupExitHandler } from "../core/lifecycle.js";
import { setupCmdPoller } from "../core/cmdPoller.js";
import { showBanner } from "../utils/tui.js";
import { ensureKeyData, getVersion } from "../session/key.js";
import { DELAYS } from "../config.js";

export async function startUiMode() {
  writePid("agent", process.pid);
  showBanner(getVersion());
  const keyData = await ensureKeyData();

  const themeArg = process.argv.find((a) => a.startsWith("--theme="));
  const theme = themeArg ? themeArg.split("=")[1] : null;

  const alreadyRunning = await isServerRunning();
  const serverManager = alreadyRunning
    ? { getProcess: () => null, shutdown: () => {} }
    : startServerWithRestart(null, null);

  if (!alreadyRunning) await new Promise((r) => setTimeout(r, DELAYS.serverBootMs));

  const uiUrl = `http://localhost:${SERVER_PORT}`;
  console.log(chalk.green(`\n🌐 UI ready at ${uiUrl}`));

  let activeTunnel = null;
  await pushUiState({ permanentKey: keyData.key, step: STEP.STOPPED, theme });

  setupExitHandler(serverManager, null);
  setupCmdPoller(() => activeTunnel, (t) => { activeTunnel = t; }, keyData.key, () => serverManager);

  if (process.argv.includes("--start")) writeCmd("start-tunnel");

  await new Promise(() => {});
}
