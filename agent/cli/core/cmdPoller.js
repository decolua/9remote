import { browserFetch, SERVER_PORT, STEP } from "../../lib/constants.js";
import { getHostPublicKeyB64, getHostX25519PublicKeyB64 } from "../../lib/hostKey.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("cmd");
import { readAndClearCmd, loadKey, saveKey, loadState, loadSettings } from "../utils/state.js";
import { stopTunnelHealthWatchdog, updateTunnelHealthUrl } from "../utils/tunnelHealth.js";
import { ensureCloudflared, spawnQuickTunnel } from "../utils/cloudflared.js";
import { updateTrayTooltip } from "../utils/tray.js";
import { getConsistentMachineId } from "../utils/machineId.js";
import { generateApiKeyV2, headOf, maskApiKey } from "../utils/apiKey.js";
import { registerSession } from "../utils/token.js";
import { apiGet, apiPost, pushUiState, setStep, onBinaryProgress } from "./localApi.js";
import { makeTunnelRestartHandler, startBackgroundTunnelReconnect, cancelActiveBgTunnel } from "../tunnel/manager.js";
import { waitForTunnelReady } from "../tunnel/readiness.js";
import { updateTunnelUrl, markRemoteOffline, startSessionHeartbeat } from "../tunnel/urlSync.js";
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
      if (cmd === "stop-tunnel") await handleStop(getActiveTunnel, setActiveTunnel, apiKey);
      else if (cmd === "restart-tunnel") {
        await handleStop(getActiveTunnel, setActiveTunnel, apiKey);
        await handleStart(getActiveTunnel, setActiveTunnel, apiKey);
      }
      else if (cmd === "start-tunnel") {
        const handled = await handleStart(getActiveTunnel, setActiveTunnel, apiKey);
        if (handled === "alreadyRunning") { busy = false; return; }
      }
      else if (cmd === "regenerate-key") await handleRegenerate();
      else if (cmd === "shutdown") handleShutdown(getActiveTunnel, setActiveTunnel);
      else if (cmd === "update") {
        const ok = await runWebUpdate();
        logger.info(`cmd update -> ${ok ? "started" : "SKIPPED (see reasons above)"}`);
      }
      else if (cmd === "restart") restartServer(getServerManager?.());
    } catch (err) {
      // A throw here would surface as an unhandled rejection and take the CLI down
      logger.error(`cmd "${cmd}" failed: ${err?.message || err}`);
    } finally {
      busy = false;
    }
  }, POLL.cmdMs);
}

async function handleStop(getActiveTunnel, setActiveTunnel, apiKey) {
  cancelActiveBgTunnel();
  stopTunnelHealthWatchdog();
  const tunnel = getActiveTunnel();
  if (tunnel) {
    tunnel.kill();
    setActiveTunnel(null);
    logger.info("Tunnel stopped");
  }
  // Nothing remote can reach us now — the Worker must stop handing out this key,
  // including the 300s grace window it would otherwise keep it alive for.
  if (apiKey) await markRemoteOffline(apiKey);
  await setStep(STEP.STOPPED, { tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "" });
  updateTrayTooltip({ tunnelUrl: "", running: true });
}

async function handleStart(getActiveTunnel, setActiveTunnel, apiKey) {
  // The remote switch is off — a stray start cmd (stale chip tap) must not bring the tunnel back
  if (loadSettings().remoteEnabled === false) {
    logger.info("Start skipped — remote is disabled");
    return;
  }
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
  // Cancel any lingering background reconnect from a previous failed start
  cancelActiveBgTunnel();
  logger.info("Starting...");
  try {
    await setStep(STEP.PREPARING);
    await ensureCloudflared(onBinaryProgress);

    await setStep(STEP.CONNECTING);
    const sessionResponse = await browserFetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: headOf(apiKey), hostPublicKey: getHostPublicKeyB64(), hostX25519Key: getHostX25519PublicKeyB64() }),
    });
    if (!sessionResponse.ok) throw new Error(`Session create failed: ${sessionResponse.status}`);
    // The row the DO gate needs now exists — revive a relay that gave up before it did.
    await apiPost("/api/signaling/retry", {});
    // Undo the goodbye handleStop sent: login must read this agent as online
    // again, and that must not wait on a tunnel URL (RTC-only is a valid state).
    startSessionHeartbeat(apiKey);

    // Spawn tunnel after a successful session. Fail/health-timeout is non-fatal:
    // show QR (RTC-only) and let the background reconnect loop retry.
    await setStep(STEP.TUNNELING);
    const onUrlUpdate = async (newUrl) => {
      await updateTunnelUrl(apiKey, newUrl);
      await pushUiState({ tunnelUrl: newUrl });
      updateTunnelHealthUrl(newUrl);
      updateTrayTooltip({ tunnelUrl: newUrl, running: true });
    };
    const onRetry = ({ attempt, delay }) => {
      pushUiState({ tunnelRetry: { attempt, delay, at: Date.now() } });
    };
    // Foreground: one spawn attempt (90s timeout inside spawnQuickTunnel).
    // Fail or health-timeout → show QR (RTC-only) + background reconnect.
    let result = null;
    try {
      result = await spawnQuickTunnel(
        SERVER_PORT,
        onUrlUpdate,
        makeTunnelRestartHandler({ onUrlUpdate, setTunnel: (c) => setActiveTunnel(c), onRetry }),
      );
    } catch (err) {
      logger.error(`Tunnel spawn failed: ${err?.message || err} — QR RTC-only, bg retry`);
    }
    pushUiState({ tunnelRetry: null });
    let tunnelUrl = "";
    if (result) {
      setActiveTunnel(result.child);
      tunnelUrl = result.tunnelUrl;
      await setStep(STEP.VERIFYING);
      if (!(await waitForTunnelReady(tunnelUrl))) {
        logger.warn("Tunnel health check timed out — bg reconnect");
        tunnelUrl = "";
        setActiveTunnel(null);
        result = null;
      }
    }
    await showConnectionInfo(apiKey, tunnelUrl);
    // Foreground success reaches READY here — only the bg-reconnect onReady did
    // before, so a started-from-UI tunnel reported "down" to RTC clients forever.
    await setStep(STEP.READY, { tunnelUrl });
    if (!result) {
      startBackgroundTunnelReconnect(SERVER_PORT, {
        onUrlUpdate,
        onRestart: makeTunnelRestartHandler({ onUrlUpdate, setTunnel: (c) => setActiveTunnel(c), onRetry }),
        setActiveTunnel,
        onReady: async (r) => { await setStep(STEP.READY, { tunnelUrl: r.tunnelUrl }); },
      });
    }
  } catch (err) {
    logger.error(`Failed to start: ${err.message}`);
    await setStep(STEP.STOPPED);
  }
}

async function handleRegenerate() {
  // Regenerating registers the new key with the Worker — local-only has no use for it
  if (loadSettings().remoteEnabled === false) {
    logger.info("Key regeneration skipped — remote is disabled");
    return;
  }
  const machineId = await getConsistentMachineId();
  const key = generateApiKeyV2(machineId);
  const existing = loadKey();
  // Register before storing — a key with no session row can never log in.
  if (!(await registerSession(key, WORKER_URL, loadState()?.tunnelUrl, existing?.key))) {
    logger.error("Key regeneration aborted — could not register the new key");
    return;
  }
  saveKey(machineId, key, existing?.name || "Default");
  // pairingUsed: the old code belonged to the replaced key — clearing it must
  // not make the UI auto-mint a fresh one (mirrors api/key.js handleRegenerate).
  await pushUiState({ permanentKey: key, oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "", pairingUsed: true });
  logger.info(`Key regenerated: ${maskApiKey(key)}`);
}

function handleShutdown(getActiveTunnel, setActiveTunnel) {
  cancelActiveBgTunnel();
  logger.info("Shutting down 9Remote completely...");
  const tunnel = getActiveTunnel();
  setActiveTunnel(null);
  shutdownAll({ tunnelProcess: tunnel });
  logger.info("9Remote stopped");
}
