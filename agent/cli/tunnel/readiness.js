import { browserFetch } from "../../lib/constants.js";
import { flushWinDns, resolveTunnelDns } from "../utils/dnsProbe.js";
import { updateProgressDesc } from "../utils/tui.js";
import { pushUiState } from "../core/localApi.js";
import { HEALTH_CHECK } from "../config.js";

export async function waitForTunnelReady(tunnelUrl, opts = {}) {
  const intervalMs = opts.intervalMs ?? HEALTH_CHECK.intervalMs;
  const timeoutMs = opts.timeoutMs ?? HEALTH_CHECK.timeoutMs;
  const healthUrl = `${tunnelUrl}/api/health`;
  const hostname = (() => { try { return new URL(tunnelUrl).hostname; } catch { return null; } })();
  const start = Date.now();
  let attempt = 0;
  const logs = [];

  await pushUiState({ healthCheck: { running: true, timeoutMs, startedAt: start, logs: [] } });

  const pushLog = (entry) => {
    logs.push(entry);
    const trimmed = logs.length > HEALTH_CHECK.maxLogEntries ? logs.slice(-HEALTH_CHECK.maxLogEntries) : logs;
    pushUiState({ healthCheck: { running: true, timeoutMs, startedAt: start, logs: trimmed } });
  };

  while (Date.now() - start < timeoutMs) {
    attempt++;
    flushWinDns();

    // DNS probe via 1.1.1.1 — detect subdomain propagation before fetching
    if (hostname) {
      const dnsRes = await resolveTunnelDns(hostname, HEALTH_CHECK.dnsTimeoutMs);
      if (!dnsRes.ok) {
        const isWaiting = dnsRes.code === "ENOTFOUND" || dnsRes.code === "ETIMEOUT" || dnsRes.code === "ESERVFAIL";
        const status = isWaiting ? "connecting..." : dnsRes.code;
        updateProgressDesc(`#${attempt} → ${status}`);
        pushLog({ attempt, status, elapsedMs: dnsRes.elapsedMs, ok: false, waiting: isWaiting, time: Date.now() });
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
    }

    const t0 = Date.now();
    try {
      const res = await browserFetch(healthUrl, { signal: AbortSignal.timeout(HEALTH_CHECK.fetchTimeoutMs) });
      const elapsedMs = Date.now() - t0;
      updateProgressDesc(`#${attempt} → ${res.status}`);
      pushLog({ attempt, status: String(res.status), elapsedMs, ok: res.ok, time: Date.now() });
      if (res.ok) {
        await pushUiState({ healthCheck: { running: false, timeoutMs: 0, startedAt: null, logs: [] } });
        await new Promise((r) => setTimeout(r, HEALTH_CHECK.postReadyHoldMs));
        return true;
      }
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      const code = err.cause?.code || err.code || err.message;
      const isWaiting = code === "ENOTFOUND";
      const status = isWaiting ? "connecting..." : code;
      updateProgressDesc(`#${attempt} → ${status}`);
      pushLog({ attempt, status, elapsedMs, ok: false, waiting: isWaiting, time: Date.now() });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  await pushUiState({ healthCheck: { running: false, timeoutMs, startedAt: start, logs } });
  return false;
}
