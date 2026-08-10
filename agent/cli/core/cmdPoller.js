import { browserFetch, SERVER_PORT, STEP } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("cmd");
import { readAndClearCmd, loadKey, saveKey } from "../utils/state.js";
import { stopTunnelHealthWatchdog, updateTunnelHealthUrl } from "../utils/tunnelHealth.js";
import { ensureCloudflared } from "../utils/cloudflared.js";
import { updateTrayTooltip } from "../utils/tray.js";
import { getConsistentMachineId } from "../utils/machineId.js";
import { generateApiKeyWithMachine, maskApiKey } from "../utils/apiKey.js";
import { apiGet, pushUiState, setStep, onBinaryProgress } from "./localApi.js";
import { spawnQuickTunnelWithRetry, makeTunnelRestartHandler } from "../tunnel/manager.js";
import { updateTunnelUrl } from "../tunnel/urlSync.js";
import { showConnectionInfo } from "../session/display.js";
import { shutdownAll } from "./lifecycle.js";
import { runWebUpdate } from "../utils/updateChecker.js";
import { restartServer } from "./lifecycle.js";
import { WORKER_URL, POLL, DELAYS } from "../config.js";

export function setupCmdPoller(getActiveTunnel, setActiveTunnel, apiKey, getServerManager) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    const cmd = readAndClearCmd();
    if (!cmd) return;
    busy = true;
    try {
      if (cmd === "stop-tunnel") await handleStop(getActiveTunnel, setActiveTunnel);
      else if (cmd === "restart-tunnel") {
        await handleStop(getActiveTunnel, setActiveTunnel);
        await handleStart(getActiveTunnel, setActiveTunnel, apiKey);
      }
      else if (cmd === "start-tunnel") {
        const handled = await handleStart(getActiveTunnel, setActiveTunnel, apiKey);
        if (handled === "alreadyRunning") { busy = false; return; }
      }
      else if (cmd === "regenerate-key") await handleRegenerate();
      else if (cmd === "shutdown") handleShutdown(getActiveTunnel, setActiveTunnel);
      else if (cmd === "update") await runWebUpdate();
      else if (cmd === "restart") restartServer(getServerManager?.());
    } catch (err) {
      // A throw here would surface as an unhandled rejection and take the CLI down
      logger.error(`cmd "${cmd}" failed: ${err?.message || err}`);
    } finally {
      busy = false;
    }
  }, POLL.cmdMs);
}

async function handleStop(getActiveTunnel, setActiveTunnel) {
  stopTunnelHealthWatchdog();
  const tunnel = getActiveTunnel();
  if (tunnel) {
    tunnel.kill();
    setActiveTunnel(null);
    logger.info("Tunnel stopped");
  }
  await setStep(STEP.STOPPED, { tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null });
  updateTrayTooltip({ tunnelUrl: "", running: true });
}

async function handleStart(getActiveTunnel, setActiveTunnel, apiKey) {
  const existing = getActiveTunnel();
  if (existing) {
    if (existing.killed || existing.exitCode != null) {
      setActiveTunnel(null);
    } else {
      const cur = await apiGet("/api/ui/state");
      await setStep(STEP.READY, { tunnelUrl: cur?.tunnelUrl || "" });
      return "alreadyRunning";
    }
  }
  logger.info("Starting...");
  try {
    await setStep(STEP.PREPARING);
    await ensureCloudflared(onBinaryProgress);

    await setStep(STEP.CONNECTING);
    const sessionResponse = await browserFetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    if (!sessionResponse.ok) throw new Error(`Session create failed: ${sessionResponse.status}`);

    // Ready immediately — DO signaling is up, clients can connect via RTC.
    // The tunnel spawns in the background and pushes its URL when ready.
    await showConnectionInfo(apiKey, "");

    // Background tunnel spawn — non-blocking. Failure is non-fatal (RTC works
    // without it). URL updates flow to the UI via onUrlUpdate → pushUiState.
    const onUrlUpdate = async (newUrl) => {
      await updateTunnelUrl(apiKey, newUrl);
      await pushUiState({ tunnelUrl: newUrl });
      updateTunnelHealthUrl(newUrl);
      updateTrayTooltip({ tunnelUrl: newUrl, running: true });
    };
    const onRetry = ({ attempt, delay }) => {
      pushUiState({ tunnelRetry: { attempt, delay, at: Date.now() } });
    };
    spawnQuickTunnelWithRetry(
      SERVER_PORT,
      onUrlUpdate,
      makeTunnelRestartHandler({ onUrlUpdate, setTunnel: (c) => setActiveTunnel(c), onRetry }),
      onRetry,
    ).then((result) => {
      setActiveTunnel(result.child);
      pushUiState({ tunnelRetry: null });
      onUrlUpdate(result.tunnelUrl);
    }).catch((err) => {
      logger.error(`Tunnel background spawn gave up: ${err?.message || err}`);
      pushUiState({ tunnelRetry: null });
    });
  } catch (err) {
    logger.error(`Failed to start: ${err.message}`);
    await setStep(STEP.STOPPED);
  }
}

async function handleRegenerate() {
  const machineId = await getConsistentMachineId();
  const { key } = generateApiKeyWithMachine(machineId);
  const existing = loadKey();
  saveKey(machineId, key, existing?.name || "Default");
  await pushUiState({ permanentKey: key });
  logger.info(`Key regenerated: ${maskApiKey(key)}`);
}

function handleShutdown(getActiveTunnel, setActiveTunnel) {
  logger.info("Shutting down 9Remote completely...");
  const tunnel = getActiveTunnel();
  setActiveTunnel(null);
  shutdownAll({ tunnelProcess: tunnel });
  logger.info("9Remote stopped");
}
