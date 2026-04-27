import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { SERVER_PORT } from "../../lib/constants.js";
import { LOG_FILE_PATH } from "../../lib/logger.js";
import { writePid } from "../utils/pids.js";
import { openBrowser } from "../utils/tray.js";
import { isServerRunning } from "../core/localApi.js";
import { killProcessOnPort } from "../core/lifecycle.js";
import { POLL, DELAYS } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function launchBackground() {
  const uiUrl = `http://localhost:${SERVER_PORT}`;

  // Kill orphan server so fresh agent owns its child — otherwise tray Shutdown is a no-op
  if (await isServerRunning()) {
    killProcessOnPort(SERVER_PORT);
    await new Promise((r) => setTimeout(r, 500));
  }

  // Bundle: dist/cli.cjs ; Dev: agent/cli/index.js
  const scriptPath = typeof __CLI_VERSION__ !== "undefined"
    ? path.resolve(__dirname, "..", "cli.cjs")
    : path.resolve(__dirname, "..", "index.js");
  const bgArgs = [scriptPath, "--tray"];

  const themeArg = process.argv.find((a) => a.startsWith("--theme="));
  if (themeArg) bgArgs.push(themeArg);

  const logPath = LOG_FILE_PATH;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `\n=== ${new Date().toISOString()} spawn bg ===\n`);
  } catch {}

  let bgPid = null;

  // Detached spawn — windowsHide + ignore stdio prevents black cmd flash on Windows.
  // Write agent.pid in PARENT so updater finds it even if child crashes early.
  try {
    const logFd = fs.openSync(logPath, "a");
    const bg = spawn(process.execPath, bgArgs, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    });
    bg.unref();
    try { fs.closeSync(logFd); } catch {}
    bgPid = bg.pid;
    if (bg.pid) writePid("agent", bg.pid);
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

  openBrowser(uiUrl);
  const pidStr = bgPid ? ` (PID: ${bgPid})` : "";
  console.log(chalk.green(`\n🌐 9Remote running at ${uiUrl}${pidStr}`));
  console.log(chalk.gray(`💡 Log: ${logPath}\n`));
  await new Promise((r) => setTimeout(r, DELAYS.bgSpawnFlushMs));
  process.exit(0);
}
