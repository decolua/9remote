import { TUNNEL_HEALTH, SERVER_PORT, browserFetch } from "../../lib/constants.js";

let intervalId = null;

// CLI runs in a separate process from the HTTP server — push state over HTTP
// so SSE clients (web UI) actually receive the update.
async function pushState(data) {
  try {
    await fetch(`http://localhost:${SERVER_PORT}/api/ui/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch {}
}

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
  await pushState({
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
  pushState({ tunnelHealth: { status: "unknown", checkedAt: null } });
}
