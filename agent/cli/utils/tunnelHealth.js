import { TUNNEL_HEALTH, SERVER_PORT } from "../../lib/constants.js";
import { probeTunnelOnce, flushWinDns } from "./dnsProbe.js";
import { tunnelLog } from "./tunnelLog.js";

let intervalId = null;
let currentUrl = null;
let lastStatus = null;

async function pushState(data) {
  try {
    await fetch(`http://localhost:${SERVER_PORT}/api/ui/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch {}
}

async function runCheck() {
  if (!currentUrl) return;
  const res = await probeTunnelOnce(currentUrl);
  const status = res.ok ? "healthy" : "unreachable";
  // Only log on transition (healthy→unreachable or vice versa) to avoid spam
  if (status !== lastStatus) {
    tunnelLog(`🩺 ${lastStatus ?? "init"} → ${status}${res.ok ? "" : ` (http=${res.httpStatus ?? "-"} dns=${res.dnsCode ?? "-"})`}`);
    lastStatus = status;
  }
  await pushState({ tunnelHealth: { status, checkedAt: Date.now() } });
}

// Same URL keeps existing interval; URL change triggers DNS flush + immediate check
export function setTunnelHealthUrl(url) {
  if (!url) return stopTunnelHealthWatchdog();
  if (url === currentUrl) return;
  currentUrl = url;
  lastStatus = null;
  flushWinDns();
  if (!intervalId) intervalId = setInterval(runCheck, TUNNEL_HEALTH.checkIntervalMs);
  runCheck();
}

// Trigger immediate re-check (e.g. after urlSync OK signaling network restored)
export function recheckTunnelHealth() {
  if (currentUrl) runCheck();
}

export const startTunnelHealthWatchdog = setTunnelHealthUrl;
export const updateTunnelHealthUrl = setTunnelHealthUrl;

export function stopTunnelHealthWatchdog() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  currentUrl = null;
  lastStatus = null;
  pushState({ tunnelHealth: { status: "unknown", checkedAt: null } });
}
