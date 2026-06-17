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
import { waitForTunnelReady } from "../tunnel/readiness.js";
import { showConnectionInfo } from "../session/display.js";
import { shutdownAll } from "./lifecycle.js";
import { WORKER_URL, POLL, DELAYS } from "../config.js";

export function setupCmdPoller(getActiveTunnel, setActiveTunnel, apiKey) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    const cmd = readAndClearCmd();
    if (!cmd) return;
    busy = true;
    try {
      if (cmd === "stop-tunnel") await handleStop(getActiveTunnel, setActiveTunnel);
      else if (cmd === "start-tunnel") {
        const handled = await handleStart(getActiveTunnel, setActiveTunnel, apiKey);
        if (handled === "alreadyRunning") { busy = false; return; }
      }
      else if (cmd === "regenerate-key") await handleRegenerate();
      else if (cmd === "shutdown") handleShutdown(getActiveTunnel, setActiveTunnel);
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
    logger.info("🛑 Tunnel stopped");
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
  logger.info("🚀 Starting tunnel...");
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

    await setStep(STEP.TUNNELING);
    const onUrlUpdate = async (newUrl) => {
      await updateTunnelUrl(apiKey, newUrl);
      await pushUiState({ tunnelUrl: newUrl });
      updateTunnelHealthUrl(newUrl);
    };
    const result = await spawnQuickTunnelWithRetry(
      SERVER_PORT,
      onUrlUpdate,
      makeTunnelRestartHandler({ onUrlUpdate, setTunnel: (c) => setActiveTunnel(c) }),
    );
    setActiveTunnel(result.child);

    await setStep(STEP.VERIFYING);
    const tunnelOk = await waitForTunnelReady(result.tunnelUrl);
    if (!tunnelOk) logger.warn("⚠️  Tunnel health check timed out, proceeding anyway...");

    await updateTunnelUrl(apiKey, result.tunnelUrl);
    updateTrayTooltip({ tunnelUrl: result.tunnelUrl, running: true });

    await new Promise((r) => setTimeout(r, DELAYS.postReadyHoldMs));
    await showConnectionInfo(apiKey, result.tunnelUrl);
  } catch (err) {
    logger.error(`❌ Failed to start tunnel: ${err.message}`);
    await setStep(STEP.STOPPED);
  }
}

async function handleRegenerate() {
  const machineId = await getConsistentMachineId();
  const { key } = generateApiKeyWithMachine(machineId);
  const existing = loadKey();
  saveKey(machineId, key, existing?.name || "Default");
  await pushUiState({ permanentKey: key });
  logger.info(`✅ Key regenerated: ${maskApiKey(key)}`);
}

function handleShutdown(getActiveTunnel, setActiveTunnel) {
  logger.info("🛑 Shutting down 9Remote completely...");
  const tunnel = getActiveTunnel();
  setActiveTunnel(null);
  shutdownAll({ tunnelProcess: tunnel });
  logger.info("✅ 9Remote stopped");
}
