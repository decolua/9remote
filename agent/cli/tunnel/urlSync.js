import { browserFetch, SERVER_PORT, RETRY_CONFIG } from "../../lib/constants.js";
import { tunnelLog } from "../utils/tunnelLog.js";
import { retryForever } from "../utils/backoff.js";
import { startTunnelHealthWatchdog, recheckTunnelHealth } from "../utils/tunnelHealth.js";
import { getLanIp } from "../core/localApi.js";
import { WORKER_URL } from "../config.js";

let urlSyncCtx = null;

export async function updateTunnelUrl(selectedKey, tunnelUrl) {
  if (urlSyncCtx) urlSyncCtx.cancelled = true;
  const ctx = { cancelled: false };
  urlSyncCtx = ctx;
  const lanIp = getLanIp();

  retryForever({
    config: RETRY_CONFIG.urlSync,
    label: `urlSync ${tunnelUrl}`,
    log: tunnelLog,
    ctx,
    task: async () => {
      const res = await browserFetch(`${WORKER_URL}/api/session/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: selectedKey, tunnelUrl, localIp: lanIp ? `${lanIp}:${SERVER_PORT}` : null }),
      });
      if (ctx.cancelled) return true;
      if (res.ok) {
        tunnelLog(`✅ urlSync ok`);
        recheckTunnelHealth();
        return true;
      }
      const txt = await res.text().catch(() => "");
      tunnelLog(`⚠️  urlSync HTTP ${res.status}: ${txt.slice(0, 200)}`);
      return false;
    },
  });

  if (tunnelUrl) startTunnelHealthWatchdog(tunnelUrl);
}
