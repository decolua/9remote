import { TUNNEL_HEALTH, browserFetch } from "../../lib/constants.js";
import { updateUiState } from "../../api/ui.js";

let intervalId = null;

async function pingHealth(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TUNNEL_HEALTH.requestTimeoutMs);
  try {
    const res = await browserFetch(`${url}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(url) {
  const ok = await pingHealth(url);
  updateUiState({
    tunnelHealth: {
      status: ok ? "healthy" : "unreachable",
      checkedAt: Date.now(),
    },
  });
}

export function startTunnelHealthWatchdog(url) {
  stopTunnelHealthWatchdog();
  if (!url) return;
  runCheck(url);
  intervalId = setInterval(() => runCheck(url), TUNNEL_HEALTH.checkIntervalMs);
}

export function stopTunnelHealthWatchdog() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  updateUiState({ tunnelHealth: { status: "unknown", checkedAt: null } });
}
