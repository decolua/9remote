import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { SERVER_PORT, RETRY_CONFIG } from "../../lib/constants.js";
import { computeDelay } from "../utils/backoff.js";
import { killCloudflared, resetRestartCounter } from "../utils/cloudflared.js";
import { stopTunnelHealthWatchdog } from "../utils/tunnelHealth.js";
import { killTray } from "../utils/tray.js";
import { clearState } from "../utils/state.js";
import { clearPid } from "../utils/pids.js";
import { SERVER_HEALTHY_RESET_MS, SHUTDOWN_EXIT_DELAY_MS, SHUTDOWN_CRASH_DELAY_MS } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STANDALONE_SERVER = path.resolve(__dirname, "../../dist/server.cjs");
const DEV_SERVER = path.resolve(__dirname, "../../index.js");

export function killProcessOnPort(port) {
  try {
    if (process.platform === "win32") {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`, { stdio: "ignore", windowsHide: true });
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    }
  } catch {}
}

export function startServerWithRestart(onReady, onServerCrash, onRestarted) {
  let currentProcess = null;
  let isShuttingDown = false;
  let isFirstStart = true;
  let failCount = 0;
  let healthyTimer = null;

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
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
      windowsHide: true,
      env: spawnEnv,
    });

    if (healthyTimer) clearTimeout(healthyTimer);
    healthyTimer = setTimeout(() => { failCount = 0; }, SERVER_HEALTHY_RESET_MS);

    currentProcess.on("exit", (code, signal) => {
      if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null; }
      if (isShuttingDown) return;

      console.log(chalk.red(`\n💥 Server exited unexpectedly (code: ${code}, signal: ${signal})`));
      failCount++;
      const delay = computeDelay(RETRY_CONFIG.server, failCount);
      console.log(chalk.yellow(`🔄 Restarting server in ${delay}ms (fail#${failCount})`));

      if (onServerCrash) {
        console.log(chalk.yellow("✅ Restarting tunnel connection..."));
        onServerCrash();
      }

      setTimeout(() => { spawnServer(); onRestarted?.(); }, delay);
    });

    currentProcess.on("error", (err) => {
      console.log(chalk.red(`❌ Server error: ${err.message}`));
    });

    onReady?.(currentProcess);
  };

  spawnServer();

  return {
    getProcess: () => currentProcess,
    shutdown: () => {
      isShuttingDown = true;
      // SIGKILL: Windows TerminateProcess fires immediately; SIGTERM leaves orphans
      if (currentProcess) { try { currentProcess.kill("SIGKILL"); } catch {} }
    },
  };
}

export function shutdownAll({ serverManager, tunnelProcess, exit = true, code = 0 } = {}) {
  try { stopTunnelHealthWatchdog(); } catch {}
  try { serverManager?.shutdown?.(); } catch {}
  try { tunnelProcess?.kill?.(); } catch {}
  try { killCloudflared(); } catch {}
  try { killTray(); } catch {}
  try { killProcessOnPort(SERVER_PORT); } catch {}
  try { resetRestartCounter(); } catch {}
  try { clearState(); } catch {}
  try { clearPid("agent"); } catch {}
  try { clearPid("cloudflared"); } catch {}
  if (exit) {
    setTimeout(() => process.exit(code), SHUTDOWN_EXIT_DELAY_MS);
  }
}

let exitHandlerRegistered = false;

// Cleanup on every shutdown path. Windows X-button needs readline iface to fire SIGHUP;
// without this, tray + cloudflared leak and lock dist/ files for next `npm i -g`.
export function setupExitHandler(serverManager, tunnelProcess) {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  let shuttingDown = false;
  const onSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { if (process.stdout.isTTY) console.log(chalk.yellow(`\n\n🛑 Stopping 9Remote (${sig})...`)); } catch {}
    shutdownAll({ serverManager, tunnelProcess });
    try { if (process.stdout.isTTY) console.log(chalk.green("✅ Server stopped")); } catch {}
  };

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGHUP", () => onSignal("SIGHUP"));

  if (process.platform === "win32") {
    process.on("SIGBREAK", () => onSignal("SIGBREAK"));
    try {
      import("readline").then(({ createInterface }) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on("SIGINT", () => onSignal("SIGINT"));
        if (process.stdin.isTTY) process.stdin.unref?.();
      }).catch(() => {});
    } catch {}
  }

  process.on("uncaughtException", (err) => {
    try { console.error(chalk.red("Uncaught exception:"), err?.message || err); } catch {}
    onSignal("uncaughtException");
    setTimeout(() => process.exit(1), SHUTDOWN_CRASH_DELAY_MS);
  });
  process.on("unhandledRejection", (err) => {
    try { console.error(chalk.red("Unhandled rejection:"), err?.message || err); } catch {}
    onSignal("unhandledRejection");
    setTimeout(() => process.exit(1), SHUTDOWN_CRASH_DELAY_MS);
  });
}
