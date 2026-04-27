import dns from "dns";
import { execFile } from "child_process";
import { browserFetch } from "../../lib/constants.js";

const PROBE_DNS_TIMEOUT_MS = 2000;
const PROBE_FETCH_TIMEOUT_MS = 5000;

const dnsResolver = new dns.promises.Resolver();
dnsResolver.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

// Win DNS negative cache holds ENOTFOUND past Cloudflare publish — flush so query hits upstream
export function flushWinDns() {
  if (process.platform !== "win32") return;
  execFile("ipconfig", ["/flushdns"], { windowsHide: true }, () => {});
}

export async function resolveTunnelDns(hostname, timeoutMs = PROBE_DNS_TIMEOUT_MS) {
  const t0 = Date.now();
  try {
    const addrs = await Promise.race([
      dnsResolver.resolve4(hostname),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error("DNS timeout"), { code: "ETIMEOUT" })), timeoutMs)
      ),
    ]);
    return { ok: true, addrs, elapsedMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, code: err.code || err.message, elapsedMs: Date.now() - t0 };
  }
}

/**
 * Single tunnel-health probe: DNS resolve via 1.1.1.1 → fetch /api/health.
 * Returns { ok, dnsCode?, httpStatus?, elapsedMs }.
 */
export async function probeTunnelOnce(url, { flushDns = false } = {}) {
  const t0 = Date.now();
  let hostname = null;
  try { hostname = new URL(url).hostname; } catch {}

  if (flushDns) flushWinDns();

  if (hostname) {
    const dnsRes = await resolveTunnelDns(hostname);
    if (!dnsRes.ok) {
      flushWinDns();
      return { ok: false, dnsCode: dnsRes.code, elapsedMs: Date.now() - t0 };
    }
  }

  try {
    const res = await browserFetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS),
    });
    return { ok: res.ok, httpStatus: res.status, elapsedMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, dnsCode: err.cause?.code || err.code || err.message, elapsedMs: Date.now() - t0 };
  }
}
