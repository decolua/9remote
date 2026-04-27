import { spawnQuickTunnel } from "../utils/cloudflared.js";
import { computeDelay } from "../utils/backoff.js";
import { RETRY_CONFIG } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("tunnel");

export async function spawnQuickTunnelWithRetry(localPort, onUrlUpdate, onRestart) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await spawnQuickTunnel(localPort, onUrlUpdate, onRestart);
    } catch (err) {
      const delay = computeDelay(RETRY_CONFIG.tunnelSpawn, attempt);
      logger.warn(`⚠️  spawn attempt ${attempt} failed: ${err?.message || err} — retry in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// First spawn registers this restart handler in cloudflared.js; subsequent restarts reuse it
export function makeTunnelRestartHandler({ onUrlUpdate, setTunnel }) {
  return async (port) => {
    try {
      const r = await spawnQuickTunnelWithRetry(port, onUrlUpdate);
      setTunnel(r.child);
      await onUrlUpdate(r.tunnelUrl);
      logger.info(`✅ Tunnel restarted: ${r.tunnelUrl}`);
    } catch (err) {
      logger.error(`❌ Tunnel restart failed: ${err?.message || err}`);
    }
  };
}
