import { browserFetch, SERVER_PORT, RETRY_CONFIG } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";
import { retryForever } from "../utils/backoff.js";
import { headOf } from "../utils/apiKey.js";
import { sessionMutationAuth } from "../../lib/hostKey.js";
import {
  startTunnelHealthWatchdog,
  pauseHealthWatchdog, resumeHealthWatchdog, setLastStatus,
} from "../utils/tunnelHealth.js";
import { getLanIp } from "../core/localApi.js";
import { waitForTunnelReady } from "./readiness.js";
import { WORKER_URL, URL_SYNC_DEBOUNCE_MS, FAST_PROBE_TIMEOUT_MS, SESSION_HEARTBEAT_INTERVAL_MS } from "../config.js";

const logger = createLogger("tunnel");

let urlSyncCtx = null;
let lastSyncedUrl = null;
let lastSyncedAt = 0;

export async function updateTunnelUrl(selectedKey, tunnelUrl) {
  logger.debug(`updateTunnelUrl: key=${selectedKey?.slice(0,8)} url=${tunnelUrl}`);
  startSessionHeartbeat(selectedKey);
  if (tunnelUrl && tunnelUrl === lastSyncedUrl && Date.now() - lastSyncedAt < URL_SYNC_DEBOUNCE_MS) {
    logger.debug(`updateTunnelUrl: skipped (debounce, same URL)`);
    return;
  }
  if (urlSyncCtx) urlSyncCtx.cancelled = true;
  const ctx = { cancelled: false };
  urlSyncCtx = ctx;
  const lanIp = getLanIp();

  retryForever({
    config: RETRY_CONFIG.urlSync,
    label: `urlSync ${tunnelUrl}`,
    log: (m) => logger.warn(m),
    ctx,
    task: async () => {
      const res = await browserFetch(`${WORKER_URL}/api/session/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify((() => {
          const fields = { apiKey: headOf(selectedKey), tunnelUrl, localIp: lanIp ? `${lanIp}:${SERVER_PORT}` : null };
          return { ...fields, ...sessionMutationAuth(fields) };
        })()),
      });
      if (ctx.cancelled) return true;
      if (res.ok) {
        lastSyncedUrl = tunnelUrl;
        lastSyncedAt = Date.now();
        logger.debug(`urlSync OK: pushed ${tunnelUrl} to server`);
        runFastHealthProbe(tunnelUrl);
        return true;
      }
      const txt = await res.text().catch(() => "");
      logger.warn(`urlSync HTTP ${res.status}: ${txt.slice(0, 200)}`);
      return false;
    },
  });

  if (tunnelUrl) startTunnelHealthWatchdog(tunnelUrl);
}

// ── Session heartbeat ────────────────────────────────────────────────────────
// The Worker cannot tell a running agent from a crashed one on its own — a
// session row survives both. A periodic beat keeps agentSeenAt fresh and a
// goodbye on shutdown marks agentOnline=0, so /api/connect can answer "agent
// is offline" at login instead of handing out a dead tunnel.
let heartbeatTimer = null;
let heartbeatKey = null;
let heartbeatBusy = false;
let lastBeatAt = 0;

async function postHeartbeat(apiKey, online) {
  const fields = { apiKey, online };
  const res = await browserFetch(`${WORKER_URL}/api/session/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...fields, ...sessionMutationAuth(fields) }),
  });
  if (!res.ok) logger.warn(`heartbeat online=${online} HTTP ${res.status}`);
  return res.ok;
}

async function beat() {
  if (heartbeatBusy || !heartbeatKey) return;
  heartbeatBusy = true;
  try {
    await postHeartbeat(heartbeatKey, true);
    lastBeatAt = Date.now();
  } catch (e) {
    logger.debug(`heartbeat failed: ${e?.message || e}`);
  } finally {
    heartbeatBusy = false;
  }
}

/** Idempotent per key; re-invoked with the same key only re-beats when the
 *  last one is stale (e.g. right after the machine woke from sleep). */
export function startSessionHeartbeat(selectedKey) {
  const apiKey = headOf(selectedKey);
  if (!apiKey) return;
  if (heartbeatTimer && heartbeatKey === apiKey) {
    if (Date.now() - lastBeatAt >= SESSION_HEARTBEAT_INTERVAL_MS) beat();
    return;
  }
  stopSessionHeartbeat();
  heartbeatKey = apiKey;
  beat(); // first beat lands now so a just-started agent reads online at once
  heartbeatTimer = setInterval(beat, SESSION_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

/** Stop the beat and, on shutdown, tell the Worker we are gone on purpose —
 *  login flips to offline instantly instead of waiting out the grace window.
 *  Returns the in-flight goodbye promise (caller bounds it), or null. */
export function stopSessionHeartbeat({ offline = false } = {}) {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  const key = heartbeatKey;
  heartbeatKey = null;
  lastBeatAt = 0;
  if (!offline || !key) return null;
  return postHeartbeat(key, false).catch((e) => logger.debug(`goodbye failed: ${e?.message || e}`));
}

let fastProbeCtx = null;

// Pause watchdog to avoid duplicate probes; on healthy, sync watchdog state so it doesn't re-log transition
async function runFastHealthProbe(tunnelUrl) {
  if (fastProbeCtx?.url === tunnelUrl) return;
  const ctx = { url: tunnelUrl };
  fastProbeCtx = ctx;
  pauseHealthWatchdog();
  try {
    const ok = await waitForTunnelReady(tunnelUrl, { timeoutMs: FAST_PROBE_TIMEOUT_MS });
    if (fastProbeCtx !== ctx) return;
    if (ok) {
      setLastStatus("healthy");
    }
  } catch {} finally {
    if (fastProbeCtx === ctx) fastProbeCtx = null;
    resumeHealthWatchdog();
  }
}
