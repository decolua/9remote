import { browserFetch, SERVER_PORT, STEP } from "../../lib/constants.js";
import { getHostPublicKeyB64, getHostX25519PublicKeyB64 } from "../../lib/hostKey.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("mode");
import { saveState } from "../utils/state.js";
import { headOf } from "../utils/apiKey.js";
import { killCloudflared, spawnQuickTunnel } from "../utils/cloudflared.js";
import { updateTunnelHealthUrl } from "../utils/tunnelHealth.js";
import {
  isServerRunning, pushUiState, setStep,
} from "../core/localApi.js";
import { startServerWithRestart, setupExitHandler } from "../core/lifecycle.js";
import { setupCmdPoller } from "../core/cmdPoller.js";
import { makeTunnelRestartHandler, startBackgroundTunnelReconnect } from "../tunnel/manager.js";
import { updateTunnelUrl } from "../tunnel/urlSync.js";
import { waitForTunnelReady } from "../tunnel/readiness.js";
import { ensureKeyData, getVersion } from "../session/key.js";
import { showConnectionInfo } from "../session/display.js";
import { showBanner } from "../utils/tui.js";
import { maskApiKey } from "../utils/apiKey.js";
import { WORKER_URL, DELAYS, POLL } from "../config.js";

async function startServerAndTunnel(selectedKey) {
  logger.info("Starting server...");
  await setStep(STEP.PREPARING);

  try { killCloudflared(); await new Promise((r) => setTimeout(r, DELAYS.killCloudflaredMs)); } catch {}

  try {
    const res = await browserFetch(`${WORKER_URL}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: headOf(selectedKey), hostPublicKey: getHostPublicKeyB64(), hostX25519Key: getHostX25519PublicKeyB64() }),
    });
    if (!res.ok) { logger.error(`Session create failed: ${res.status}`); return null; }
  } catch (e) {
    logger.error(`Session create failed: ${e.message}`); return null;
  }

  const alreadyRunning = await isServerRunning();
  const serverManager = alreadyRunning
    ? { getProcess: () => null, shutdown: () => {} }
    : startServerWithRestart(null, null);

  if (!alreadyRunning) await new Promise((r) => setTimeout(r, DELAYS.serverBootMs));

  logger.info("Starting tunnel...");
  await setStep(STEP.CONNECTING);

  const tunnelRef = { current: null };
  let tunnelUrl = "";
  const onUrlUpdate = async (newUrl) => {
    logger.info(`Tunnel URL rotated: ${newUrl}`);
    await updateTunnelUrl(selectedKey, newUrl);
    pushUiState({ tunnelUrl: newUrl });
    updateTunnelHealthUrl(newUrl);
  };
  // Foreground: one spawn attempt. Fail/health-timeout → RTC-only + background reconnect.
  let result = null;
  try {
    result = await spawnQuickTunnel(
      SERVER_PORT,
      onUrlUpdate,
      makeTunnelRestartHandler({ onUrlUpdate, setTunnel: (c) => { tunnelRef.current = c; } }),
    );
  } catch (error) {
    logger.error(`Tunnel spawn failed: ${error.message} — RTC-only, bg retry`);
  }
  if (result) {
    tunnelRef.current = result.child;
    tunnelUrl = result.tunnelUrl;
    if (!(await waitForTunnelReady(tunnelUrl))) {
      logger.warn("Tunnel health check timed out — bg reconnect");
      tunnelRef.current = null;
      tunnelUrl = "";
      result = null;
    }
  }
  if (!result) {
    startBackgroundTunnelReconnect(SERVER_PORT, {
      onUrlUpdate,
      onRestart: makeTunnelRestartHandler({ onUrlUpdate, setTunnel: (c) => { tunnelRef.current = c; } }),
      setActiveTunnel: (c) => { tunnelRef.current = c; },
      onReady: async (r) => { await setStep(STEP.READY, { tunnelUrl: r.tunnelUrl }); },
    });
  }

  if (tunnelUrl) await updateTunnelUrl(selectedKey, tunnelUrl);

  saveState({
    apiKey: selectedKey,
    tunnelUrl,
    serverPid: serverManager.getProcess()?.pid,
    tunnelPid: tunnelRef.current?.pid,
  });

  return { serverManager, tunnelRef, tunnelUrl };
}

export async function autoStartDev() {
  showBanner(getVersion());
  const keyData = await ensureKeyData();
  logger.info(`Using key: ${maskApiKey(keyData.key)} (${keyData.name})`);

  const result = await startServerAndTunnel(keyData.key);
  if (!result) process.exit(1);

  const { serverManager, tunnelRef, tunnelUrl } = result;

  await showConnectionInfo(keyData.key, tunnelUrl);
  setupExitHandler(serverManager, tunnelRef.current);
  setupCmdPoller(() => tunnelRef.current, (t) => { tunnelRef.current = t; }, keyData.key);

  const startTime = Date.now();
  setInterval(() => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = uptime % 60;
    pushUiState({ uptime: `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` });
  }, POLL.statsMs);

  await new Promise(() => {});
}
