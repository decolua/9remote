import path from "path";
import fs from "fs";
import chalk from "chalk";
import { SERVER_PORT } from "../../lib/constants.js";
import { LOG_FILE_PATH } from "../../lib/logger.js";
import { writePid } from "../utils/pids.js";
import { writeCmd } from "../utils/state.js";
import { openBrowser } from "../utils/tray.js";
import { spawnHidden } from "../utils/autostart.js";
import { isServerRunning } from "../core/localApi.js";
import { killProcessOnPort } from "../core/lifecycle.js";
import { POLL, DELAYS } from "../config.js";

export async function launchBackground() {
  const uiUrl = `http://localhost:${SERVER_PORT}`;

  // Kill orphan server so fresh agent owns its child — otherwise tray Shutdown is a no-op
  if (await isServerRunning()) {
    killProcessOnPort(SERVER_PORT);
    await new Promise((r) => setTimeout(r, 500));
  }

  const trayArgs = ["--tray"];
  const themeArg = process.argv.find((a) => a.startsWith("--theme="));
  if (themeArg) trayArgs.push(themeArg);

  const logPath = LOG_FILE_PATH;
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}

  let bgPid = null;

  // Spawn fully hidden (no console flash on Windows). Agent self-writes its PID in tray mode.
  try {
    bgPid = spawnHidden(trayArgs);
    if (bgPid) writePid("agent", bgPid);
  } catch (err) {
    console.log(chalk.red(`\n❌ Failed to launch background: ${err.message}`));
    process.exit(1);
  }

  const deadline = Date.now() + POLL.bgServerReadyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (await isServerRunning()) { ready = true; break; }
    await new Promise((r) => setTimeout(r, POLL.bgServerReadyIntervalMs));
  }

  if (!ready) {
    console.log(chalk.red(`\n❌ Background server failed to start.`));
    console.log(chalk.gray(`   Check log: ${logPath}\n`));
    process.exit(1);
  }

  // Web UI mode → auto start tunnel (idempotent via cmdPoller handleStart)
  writeCmd("start-tunnel");

  openBrowser(uiUrl);
  const pidStr = bgPid ? ` (PID: ${bgPid})` : "";
  console.log(chalk.green(`\n🌐 9Remote running at ${uiUrl}${pidStr}`));
  console.log(chalk.gray(`💡 Log: ${logPath}\n`));
  await new Promise((r) => setTimeout(r, DELAYS.bgSpawnFlushMs));
  process.exit(0);
}
