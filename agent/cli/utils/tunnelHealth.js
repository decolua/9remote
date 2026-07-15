import { TUNNEL_HEALTH, SERVER_PORT } from "../../lib/constants.js";
import { probeTunnelOnce, flushWinDns } from "./dnsProbe.js";
import { createLogger } from "../../lib/logger.js";
import { HEALTH_FLAP_STABLE_CHECKS } from "../config.js";
import { resolveLocalHost } from "../core/localApi.js";

const logger = createLogger("tunnel");

let intervalId = null;
let currentUrl = null;
let lastStatus = null;
let pendingStatus = null;
let pendingCount = 0;
let paused = false;

async function pushState(data) {
  try {
    const host = await resolveLocalHost();
    await fetch(`http://${host}:${SERVER_PORT}/api/ui/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch {}
}

async function runCheck() {
  if (!currentUrl || paused) return;
  const res = await probeTunnelOnce(currentUrl);
  const status = res.ok ? "healthy" : "unreachable";

  // Flap debounce: only commit transition after status stays stable across N consecutive checks
  if (status === lastStatus) { pendingStatus = null; pendingCount = 0; return; }
  if (status !== pendingStatus) { pendingStatus = status; pendingCount = 1; return; }
  pendingCount++;
  if (pendingCount < HEALTH_FLAP_STABLE_CHECKS) return;

  logger.info(`🩺 ${lastStatus ?? "init"} → ${status}${res.ok ? "" : ` (http=${res.httpStatus ?? "-"} dns=${res.dnsCode ?? "-"})`}`);
  lastStatus = status;
  pendingStatus = null;
  pendingCount = 0;
  await pushState({ tunnelHealth: { status, checkedAt: Date.now() } });
}

// Same URL keeps existing interval; URL change triggers DNS flush + immediate check
export function setTunnelHealthUrl(url) {
  if (!url) return stopTunnelHealthWatchdog();
  if (url === currentUrl) return;
  currentUrl = url;
  lastStatus = null;
  pendingStatus = null;
  pendingCount = 0;
  flushWinDns();
  if (!intervalId) intervalId = setInterval(runCheck, TUNNEL_HEALTH.checkIntervalMs);
  runCheck();
}

export function recheckTunnelHealth() {
  if (currentUrl) runCheck();
}

export const startTunnelHealthWatchdog = setTunnelHealthUrl;
export const updateTunnelHealthUrl = setTunnelHealthUrl;

export function pauseHealthWatchdog() { paused = true; }
export function resumeHealthWatchdog() { paused = false; }
export function setLastStatus(status) {
  lastStatus = status;
  pendingStatus = null;
  pendingCount = 0;
  pushState({ tunnelHealth: { status, checkedAt: Date.now() } });
}

export function stopTunnelHealthWatchdog() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  currentUrl = null;
  lastStatus = null;
  pendingStatus = null;
  pendingCount = 0;
  pushState({ tunnelHealth: { status: "unknown", checkedAt: null } });
}
