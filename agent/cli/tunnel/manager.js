import chalk from "chalk";
import { spawnQuickTunnel } from "../utils/cloudflared.js";
import { tunnelLog } from "../utils/tunnelLog.js";
import { computeDelay } from "../utils/backoff.js";
import { RETRY_CONFIG } from "../../lib/constants.js";
import { COLORS } from "../config.js";

export async function spawnQuickTunnelWithRetry(localPort, onUrlUpdate, onRestart) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await spawnQuickTunnel(localPort, onUrlUpdate, onRestart);
    } catch (err) {
      const delay = computeDelay(RETRY_CONFIG.tunnelSpawn, attempt);
      tunnelLog(`⚠️  spawn attempt ${attempt} failed: ${err?.message || err} — retry in ${delay}ms`);
      console.log(chalk.yellow(`⚠️  Tunnel spawn failed (#${attempt}) — retry in ${delay / 1000}s`));
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
      tunnelLog(`✅ Tunnel restarted: ${r.tunnelUrl}`);
      console.log(COLORS.orange(`✅ Tunnel restarted: ${r.tunnelUrl}`));
    } catch (err) {
      tunnelLog(`❌ Tunnel restart failed: ${err?.message || err}`);
      console.log(chalk.red(`❌ Tunnel restart failed: ${err.message}`));
    }
  };
}
