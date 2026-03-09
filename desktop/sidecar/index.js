#!/usr/bin/env node

import { spawn, execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { getConsistentMachineId } from "../../cli/utils/machineId.js";
import { generateApiKeyWithMachine } from "../../cli/utils/apiKey.js";
import { loadKey, saveKey, loadState, saveState, clearState } from "../../cli/utils/state.js";
import { createTempKey } from "../../cli/utils/token.js";
import {
  ensureCloudflared,
  spawnCloudflared,
  killCloudflared,
  resetRestartCounter
} from "../../cli/utils/cloudflared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKER_URL = "https://9remote.cc";
const SERVER_PORT = 2208;
const SHORT_ID_CHARS = "abcdefghijklmnpqrstuvwxyz23456789";
const MAX_RESTART_ATTEMPTS = 10;
const RESTART_WINDOW_MS = 60000;
const STATS_INTERVAL_MS = 5000;
const LATENCY_MIN = 20;
const LATENCY_MAX = 40;

// When bundled: server.cjs sits next to this file; in dev: use server/index.js
const STANDALONE_SERVER = path.join(__dirname, "server.cjs");
const DEV_SERVER = path.join(__dirname, "../../server/index.js");

/** Write a structured JSON event to stdout */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function generateShortId() {
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += SHORT_ID_CHARS.charAt(Math.floor(Math.random() * SHORT_ID_CHARS.length));
  }
  return result;
}

function killProcessOnPort(port) {
  try {
    if (process.platform === "win32") {
      execSync(
        `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`,
        { stdio: "ignore" }
      );
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    }
  } catch { }
}

function startServerWithRestart(onReady, onServerCrash) {
  const restartTimes = [];
  let currentProcess = null;
  let isShuttingDown = false;
  let isFirstStart = true;

  const spawnServer = () => {
    if (isFirstStart) {
      killProcessOnPort(SERVER_PORT);
      isFirstStart = false;
    }

    const useDevServer = fs.existsSync(DEV_SERVER);
    const serverPath = useDevServer ? DEV_SERVER : STANDALONE_SERVER;

    if (!fs.existsSync(serverPath)) {
      emit({ type: "error", msg: `Server not found: ${serverPath}` });
      process.exit(1);
    }

    currentProcess = spawn("node", [serverPath], {
      cwd: path.dirname(serverPath),
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
      env: { ...process.env, PORT: String(SERVER_PORT) }
    });

    currentProcess.on("exit", (code, signal) => {
      if (isShuttingDown) return;

      if (code !== 0 || signal) {
        emit({ type: "log", level: "warn", msg: `Server crashed (code: ${code}, signal: ${signal})` });

        const now = Date.now();
        restartTimes.push(now);
        while (restartTimes.length > 0 && restartTimes[0] < now - RESTART_WINDOW_MS) {
          restartTimes.shift();
        }

        if (restartTimes.length > MAX_RESTART_ATTEMPTS) {
          emit({ type: "error", msg: `Too many restarts (${MAX_RESTART_ATTEMPTS} in ${RESTART_WINDOW_MS / 1000}s). Giving up.` });
          process.exit(1);
        }

        emit({ type: "log", level: "info", msg: `Restarting server (attempt ${restartTimes.length}/${MAX_RESTART_ATTEMPTS})` });

        if (onServerCrash) onServerCrash();

        setTimeout(() => spawnServer(), 1000);
      }
    });

    currentProcess.on("error", (err) => {
      emit({ type: "error", msg: `Server error: ${err.message}` });
    });

    if (onReady) onReady(currentProcess);
  };

  spawnServer();

  return {
    getProcess: () => currentProcess,
    shutdown: () => {
      isShuttingDown = true;
      if (currentProcess) currentProcess.kill();
    }
  };
}

async function createNamedTunnel(apiKey) {
  const response = await fetch(`${WORKER_URL}/api/tunnel/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to create tunnel");
  }

  return response.json();
}

async function startServerAndTunnel(selectedKey) {
  emit({ type: "step", step: 0, label: "Starting server" });

  try {
    killCloudflared();
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch { }

  const existingState = loadState();
  const shortId = existingState?.shortId || generateShortId();

  // Create session
  try {
    const sessionResponse = await fetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: selectedKey, shortId })
    });

    if (!sessionResponse.ok) {
      const text = await sessionResponse.text();
      emit({ type: "error", msg: `Failed to create session: ${sessionResponse.status} ${text.substring(0, 200)}` });
      return null;
    }
  } catch (error) {
    emit({ type: "error", msg: `Failed to create session: ${error.message}` });
    return null;
  }

  let tunnelProcess = null;

  const serverManager = startServerWithRestart(null, async () => {
    if (!tunnelProcess) return;

    const maxRetries = 60;
    let serverReady = false;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`http://localhost:${SERVER_PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          const data = await response.json();
          if (data.status === "ok") { serverReady = true; break; }
        }
      } catch { }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!serverReady) {
      emit({ type: "error", msg: "Server not ready after 60s - skipping tunnel reconnect" });
      return;
    }

    try {
      process.kill(tunnelProcess.pid, "SIGHUP");
    } catch {
      try {
        tunnelProcess.kill();
        await new Promise(resolve => setTimeout(resolve, 1000));
        tunnelProcess = await startTunnel(token);
      } catch (restartErr) {
        emit({ type: "error", msg: `Failed to restart tunnel: ${restartErr.message}` });
      }
    }
  });

  // Wait for server to boot
  await new Promise(resolve => setTimeout(resolve, 2000));

  emit({ type: "step", step: 1, label: "Creating tunnel" });

  try {
    await ensureCloudflared();
  } catch (error) {
    emit({ type: "error", msg: `Failed to install cloudflared: ${error.message}` });
    serverManager.shutdown();
    return null;
  }

  let tunnelData;
  try {
    tunnelData = await createNamedTunnel(selectedKey);
    emit({ type: "log", level: "info", msg: `Tunnel ID: ${tunnelData.tunnelId}` });
  } catch (error) {
    emit({ type: "error", msg: `Failed to create tunnel: ${error.message}` });
    serverManager.shutdown();
    return null;
  }

  const { token, hostname: tunnelUrl } = tunnelData;

  const startTunnel = async (tunnelToken) => {
    try {
      tunnelProcess = await spawnCloudflared(tunnelToken, startTunnel);
      return tunnelProcess;
    } catch (error) {
      emit({ type: "error", msg: `Failed to start cloudflared: ${error.message}` });
      return null;
    }
  };

  tunnelProcess = await startTunnel(token);
  if (!tunnelProcess) {
    serverManager.shutdown();
    return null;
  }

  // Verify tunnel reachability
  emit({ type: "step", step: 2, label: "Verifying tunnel" });

  let tunnelReady = false;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`${tunnelUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) { tunnelReady = true; break; }
    } catch { }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!tunnelReady) {
    emit({ type: "error", msg: "Tunnel not reachable from outside" });
    serverManager.shutdown();
    tunnelProcess.kill();
    return null;
  }

  emit({ type: "log", level: "info", msg: `Tunnel URL: ${tunnelUrl}` });

  saveState({
    apiKey: selectedKey,
    shortId,
    tunnelUrl,
    serverPid: serverManager.getProcess()?.pid,
    tunnelPid: tunnelProcess.pid
  });

  return { serverManager, tunnelProcess, tunnelUrl, token };
}

async function run() {
  const machineId = await getConsistentMachineId();
  let keyData = loadKey();

  if (!keyData.key) {
    emit({ type: "log", level: "info", msg: "No key found. Creating default key..." });
    const { key } = generateApiKeyWithMachine(machineId);
    keyData = saveKey(machineId, key, "Default");
    emit({ type: "log", level: "info", msg: "Default key created" });
  }

  emit({ type: "log", level: "info", msg: `Using key: ${keyData.key.slice(0, 20)}...` });

  const result = await startServerAndTunnel(keyData.key);
  if (!result) {
    emit({ type: "error", msg: "Failed to start server and tunnel" });
    process.exit(1);
  }

  const { serverManager, tunnelProcess, tunnelUrl } = result;

  // Create temp key for QR
  const tempKeyData = await createTempKey(keyData.key, WORKER_URL);
  if (!tempKeyData) {
    emit({ type: "error", msg: "Failed to create temp key" });
  }

  const qrUrl = tempKeyData ? `${WORKER_URL}/login?k=${tempKeyData.tempKey}` : null;

  emit({
    type: "step",
    step: "ready",
    url: tunnelUrl,
    key: tempKeyData?.tempKey || null,
    qrUrl
  });

  // Stats interval: emit latency (mock) + uptime every 5s
  const startedAt = Date.now();
  const statsInterval = setInterval(() => {
    const latency = Math.floor(Math.random() * (LATENCY_MAX - LATENCY_MIN + 1)) + LATENCY_MIN;
    const uptime = Math.floor((Date.now() - startedAt) / 1000);
    emit({ type: "stats", latency, uptime });
  }, STATS_INTERVAL_MS);

  // Graceful shutdown
  let exitHandlerRegistered = false;
  const shutdown = () => {
    if (exitHandlerRegistered) return;
    exitHandlerRegistered = true;

    clearInterval(statsInterval);
    serverManager.shutdown();
    if (tunnelProcess) tunnelProcess.kill();
    resetRestartCounter();
    clearState();

    emit({ type: "log", level: "info", msg: "Stopped" });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  await new Promise(() => { });
}

run().catch((err) => {
  emit({ type: "error", msg: err.message });
  process.exit(1);
});
