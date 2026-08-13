import { spawnQuickTunnel, killCloudflared } from "../utils/cloudflared.js";
import { computeDelay, retryForever } from "../utils/backoff.js";
import { RETRY_CONFIG } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("tunnel");

export async function spawnQuickTunnelWithRetry(localPort, onUrlUpdate, onRestart, onRetry) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await spawnQuickTunnel(localPort, onUrlUpdate, onRestart);
    } catch (err) {
      const delay = computeDelay(RETRY_CONFIG.tunnelSpawn, attempt);
      logger.warn(`spawn attempt ${attempt} failed: ${err?.message || err} — retry in ${delay}ms`);
      onRetry?.({ attempt, delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
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

// Background reconnect after foreground spawn failed or health-timed-out.
// Never gives up; backoff in minutes to avoid spamming trycloudflare rate limits.
// Singleton ctx so any mode's stop/shutdown can cancel the active loop.
let activeBgCtx = null;
export function cancelActiveBgTunnel() {
  if (activeBgCtx) { activeBgCtx.cancelled = true; activeBgCtx = null; }
}
export function startBackgroundTunnelReconnect(localPort, { onUrlUpdate, onRestart, setActiveTunnel, onReady }) {
  cancelActiveBgTunnel(); // supersede any lingering loop from a previous start
  const ctx = { cancelled: false };
  activeBgCtx = ctx;
  retryForever({
    config: RETRY_CONFIG.tunnelRateLimit,
    task: async () => {
      if (ctx.cancelled) return true;
      const r = await spawnQuickTunnel(localPort, onUrlUpdate, onRestart);
      // Spawn resolved after cancel — clean up the orphan, skip side effects
      if (ctx.cancelled) { try { killCloudflared(); } catch {} return true; }
      // Decouple side effects from spawn success — a failure here (e.g. Worker
      // sync) must not make retryForever respawn an already-up tunnel.
      try {
        setActiveTunnel?.(r.child);
        await onUrlUpdate?.(r.tunnelUrl);
        await onReady?.(r);
        logger.info(`bg tunnel up: ${r.tunnelUrl}`);
      } catch (err) {
        logger.error(`bg tunnel post-spawn failed: ${err?.message || err}`);
      }
      return true; // success → stop the loop
    },
    label: "bg-tunnel",
    log: (m) => logger.info(m),
    ctx,
  });
  return ctx;
}
