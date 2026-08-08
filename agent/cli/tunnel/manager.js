import { spawnQuickTunnelDetect } from "../utils/cloudflared.js";
import { computeDelay } from "../utils/backoff.js";
import { RETRY_CONFIG } from "../../lib/constants.js";
import { TUNNEL_SPAWN } from "../config.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("tunnel");

// Single in-flight spawn shared by every caller. Both the retry loop below and
// cloudflared's scheduleRestart funnel here — without this they race and each
// failure spawns two cloudflared processes, which feeds the rate limit.
let spawnInFlight = null;
let lastSpawnAt = 0;

async function runSpawnLoop(localPort, onUrlUpdate, onRestart, onRetry) {
  let attempt = 0;
  while (true) {
    attempt++;
    // Floor between spawns so a burst of callers can't hammer trycloudflare
    const since = Date.now() - lastSpawnAt;
    if (since < TUNNEL_SPAWN.minGapMs) {
      await new Promise((r) => setTimeout(r, TUNNEL_SPAWN.minGapMs - since));
    }
    lastSpawnAt = Date.now();
    try {
      return await spawnQuickTunnelDetect(localPort, onUrlUpdate, onRestart);
    } catch (err) {
      const rateLimited = !!err?.rateLimited;
      const config = rateLimited ? RETRY_CONFIG.tunnelRateLimit : RETRY_CONFIG.tunnelSpawn;
      const delay = computeDelay(config, attempt);
      logger.warn(`spawn attempt ${attempt} failed${rateLimited ? " (rate limited)" : ""}: ${err?.message || err} — retry in ${delay}ms`);
      onRetry?.({ attempt, delay, rateLimited });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function spawnQuickTunnelWithRetry(localPort, onUrlUpdate, onRestart, onRetry) {
  if (spawnInFlight) return spawnInFlight;
  spawnInFlight = runSpawnLoop(localPort, onUrlUpdate, onRestart, onRetry)
    .finally(() => { spawnInFlight = null; });
  return spawnInFlight;
}

// First spawn registers this restart handler in cloudflared.js; subsequent restarts reuse it
export function makeTunnelRestartHandler({ onUrlUpdate, setTunnel, onRetry }) {
  return async (port) => {
    try {
      const r = await spawnQuickTunnelWithRetry(port, onUrlUpdate, null, onRetry);
      setTunnel(r.child);
      await onUrlUpdate(r.tunnelUrl);
      logger.info(`Tunnel restarted: ${r.tunnelUrl}`);
    } catch (err) {
      logger.error(`Tunnel restart failed: ${err?.message || err}`);
    }
  };
}
