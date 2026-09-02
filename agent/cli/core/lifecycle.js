import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { SERVER_PORT, RETRY_CONFIG, NODE_BIN, nodeSpawnEnv } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";
import { computeDelay } from "../utils/backoff.js";

const logger = createLogger("server");
import { killCloudflared, resetRestartCounter } from "../utils/cloudflared.js";
import { stopTunnelHealthWatchdog } from "../utils/tunnelHealth.js";
import { killTray } from "../utils/tray.js";
import { clearState } from "../utils/state.js";
import { clearPid } from "../utils/pids.js";
import { SERVER_HEALTHY_RESET_MS, SHUTDOWN_EXIT_DELAY_MS, SHUTDOWN_CRASH_DELAY_MS, HEARTBEAT_GOODBYE_MAX_MS } from "../config.js";
import { stopSessionHeartbeat } from "../tunnel/urlSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Bundle: dist/cli.cjs → ./server.cjs ; Dev: agent/cli/core/ → ../../dist/server.cjs
const STANDALONE_SERVER = typeof __CLI_VERSION__ !== "undefined"
  ? path.resolve(__dirname, "./server.cjs")
  : path.resolve(__dirname, "../../dist/server.cjs");
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
  let isRestarting = false;
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
      logger.error(`Server not found: ${serverPath}`);
      process.exit(1);
    }

    const spawnEnv = { ...process.env, PORT: String(SERVER_PORT) };
    if (!useDevServer) delete spawnEnv.NODE_ENV;

    currentProcess = spawn(NODE_BIN, [serverPath], {
      cwd: path.dirname(serverPath),
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
      windowsHide: true,
      env: nodeSpawnEnv(spawnEnv),
    });

    if (healthyTimer) clearTimeout(healthyTimer);
    healthyTimer = setTimeout(() => { failCount = 0; }, SERVER_HEALTHY_RESET_MS);

    currentProcess.on("exit", (code, signal) => {
      if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null; }
      if (isShuttingDown) return;

      // Intentional restart (web-triggered): respawn quietly, no fail-count bump
      if (isRestarting) {
        isRestarting = false;
        logger.info("Restarting server (requested)...");
        setTimeout(() => { spawnServer(); onRestarted?.(); }, 500);
        return;
      }

      logger.error(`Server exited unexpectedly (code: ${code}, signal: ${signal})`);
      failCount++;
      const delay = computeDelay(RETRY_CONFIG.server, failCount);
      logger.warn(`Restarting server in ${delay}ms (fail#${failCount})`);

      if (onServerCrash) {
        onServerCrash();
      }

      setTimeout(() => { spawnServer(); onRestarted?.(); }, delay);
    });

    currentProcess.on("error", (err) => {
      logger.error(`Server error: ${err.message}`);
    });

    onReady?.(currentProcess);
  };

  spawnServer();

  return {
    getProcess: () => currentProcess,
    shutdown: () => {
      isShuttingDown = true;
      if (!currentProcess) return;
      // SIGTERM first → server graceful shutdown (releases caffeinate/sleep inhibitor)
      // Fallback SIGKILL after 2s if server doesn't exit cleanly
      try { currentProcess.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { if (currentProcess) currentProcess.kill("SIGKILL"); } catch {}
      }, 2000);
    },
    // Restart ONLY the server child (CLI parent + tunnel + cloudflared untouched).
    // Sets isRestarting so the exit handler respawns quietly instead of crash-retry.
    restart: () => {
      if (!currentProcess) return false;
      isRestarting = true;
      try { currentProcess.kill("SIGTERM"); } catch {}
      // Force if SIGTERM doesn't land within 2s
      setTimeout(() => {
        try { if (currentProcess && isRestarting) currentProcess.kill("SIGKILL"); } catch {}
      }, 2000);
      return true;
    },
  };
}

// Restart only the server child (keeps CLI parent + tunnel + cloudflared alive).
// No-op if the server is already gone (e.g. alreadyRunning mode without a manager).
export function restartServer(serverManager) {
  if (!serverManager?.restart) return false;
  return serverManager.restart();
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
  // Final "offline" beat before exit — never shortens the usual flush window,
  // only extends it (bounded) while the beat is in flight; if it never lands,
  // the Worker's grace window catches up.
  const goodbye = stopSessionHeartbeat({ offline: true });
  if (exit) {
    const flush = new Promise((r) => setTimeout(r, SHUTDOWN_EXIT_DELAY_MS));
    const beat = goodbye
      ? Promise.race([goodbye, new Promise((r) => setTimeout(r, HEARTBEAT_GOODBYE_MAX_MS))])
      : null;
    Promise.all([flush, beat]).finally(() => process.exit(code));
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
    logger.info(`Stopping 9Remote (${sig})...`);
    shutdownAll({ serverManager, tunnelProcess });
    logger.info("Server stopped");
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
    logger.error(`Uncaught exception: ${err?.stack || err?.message || err}`);
    onSignal("uncaughtException");
    setTimeout(() => process.exit(1), SHUTDOWN_CRASH_DELAY_MS);
  });
  process.on("unhandledRejection", (err) => {
    logger.error(`Unhandled rejection: ${err?.stack || err?.message || err}`);
    onSignal("unhandledRejection");
    setTimeout(() => process.exit(1), SHUTDOWN_CRASH_DELAY_MS);
  });
}
