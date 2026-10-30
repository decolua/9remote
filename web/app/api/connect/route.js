import { getCloudflareContext } from "@opennextjs/cloudflare";
import { isAcceptedApiKey, normalizeApiKey } from "@/shared/utils/apiKey";
import { decryptToken } from "@/shared/utils/token";
import { withD1Retry, cachedLookup, cacheKeys, CACHE_TTL } from "@/shared/utils/db";
import { RATE_LIMITS, clientIp, isRateLimited, recordFailure, clearFailures } from "@/shared/utils/rateLimit";
import { jsonOk, jsonError, jsonRateLimited, optionsResponse } from "@/shared/utils/apiResponse";

// Throttle lastAccessAt writes to reduce D1 write frequency
const LAST_ACCESS_THROTTLE_SEC = 60;
const SCOPE = "connect";
// Timeout for probing DO signaling relay presence
const RELAY_PROBE_TIMEOUT_MS = 3000;
// Probe verdict cache — each probe wakes the room's DO, and reconnect bursts
// (retry ladder, multiple tabs) ask it identical questions. Positive verdicts
// hold longer: they only skip the not-ready path. A negative verdict flips to
// true the moment a host comes online, so its TTL stays short enough that the
// worst case is one extra client retry (~2s), never a new failure mode.
const RELAY_PROBE_POS_TTL_MS = 10000;
const RELAY_PROBE_NEG_TTL_MS = 3000;
const RELAY_PROBE_PRUNE_SIZE = 5000;
const relayProbeCache = new Map();    // apiKey → { verdict, expires }
const relayProbeInflight = new Map(); // apiKey → Promise<boolean> — a burst shares one probe

// Attach host public keys for client-side tail sealing verification
const hostKeysOf = (row) => ({
  hostKeys: row.hostPublicKey ? { ed: row.hostPublicKey, x: row.hostX25519Key || null } : null
});

// Check whether an agent is currently joined to the signaling DO room
async function agentOnRelay(apiKey, env) {
  const hit = relayProbeCache.get(apiKey);
  if (hit && hit.expires > Date.now()) return hit.verdict;
  const inflight = relayProbeInflight.get(apiKey);
  if (inflight) return inflight;
  const probe = (async () => {
    try {
      const res = await env.SIGNALING_DO.get(env.SIGNALING_DO.idFromName(apiKey))
        .fetch(new Request("https://do/presence", { signal: AbortSignal.timeout(RELAY_PROBE_TIMEOUT_MS) }));
      const { agentPresent } = await res.json();
      const verdict = agentPresent === true;
      if (relayProbeCache.size > RELAY_PROBE_PRUNE_SIZE) {
        const now = Date.now();
        for (const [key, entry] of relayProbeCache) {
          if (entry.expires <= now) relayProbeCache.delete(key);
        }
      }
      relayProbeCache.set(apiKey, { verdict, expires: Date.now() + (verdict ? RELAY_PROBE_POS_TTL_MS : RELAY_PROBE_NEG_TTL_MS) });
      return verdict;
    } catch (e) {
      console.warn(`[connect] relay probe failed: ${e?.message || e}`);
      return false; // deliberately NOT cached — a transient blip must not stretch to a TTL
    } finally {
      relayProbeInflight.delete(apiKey);
    }
  })();
  relayProbeInflight.set(apiKey, probe);
  return probe;
}

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const ip = clientIp(request);
    if (isRateLimited(SCOPE, ip, RATE_LIMITS.connect)) {
      return jsonRateLimited(RATE_LIMITS.connect.windowSec);
    }

    const body = await request.json();
    let apiKey;
    let tempKey = body.tempKey || null;

    if (body.token) {
      if (body.token.length <= 10 && /^[A-Z0-9]+$/i.test(body.token)) {
        const normalized = body.token.toUpperCase();
        const row = await withD1Retry(() => env.DB.prepare(
          `SELECT api_key, expires_at FROM temp_keys WHERE temp_key = ?`
        ).bind(normalized).first());

        if (!row) {
          await recordFailure(SCOPE, ip, RATE_LIMITS.connect, env.LOGIN_RATE_LIMITER);
          return jsonError("Invalid or expired temp key", 401);
        }
        if (Date.now() > row.expires_at) {
          await withD1Retry(() => env.DB.prepare(`DELETE FROM temp_keys WHERE temp_key = ?`).bind(normalized).run());
          return jsonError("Temp key expired", 410);
        }
        apiKey = row.api_key;
        tempKey = normalized;
      } else {
        const payload = decryptToken(body.token, env);
        if (!payload) {
          await recordFailure(SCOPE, ip, RATE_LIMITS.connect, env.LOGIN_RATE_LIMITER);
          return jsonError("Invalid or expired token", 401);
        }
        apiKey = payload.key;
      }
    } else if (body.apiKey) {
      apiKey = body.apiKey;
    } else {
      return jsonError("Missing token or apiKey");
    }

    if (!(isAcceptedApiKey(apiKey))) {
      await recordFailure(SCOPE, ip, RATE_LIMITS.connect, env.LOGIN_RATE_LIMITER);
      return jsonError("Invalid API key", 401);
    }

    apiKey = normalizeApiKey(apiKey);

    clearFailures(SCOPE, ip);

    // Cache resolved tunnel URL to reduce D1 lookups on reconnect bursts
    let sessionMissing = false;
    const cached = await cachedLookup(cacheKeys.tunnel(apiKey), CACHE_TTL.tunnelSec, async () => {
      const row = await withD1Retry(() => env.DB.prepare(`
        SELECT tunnelUrl, machineId, publicIp, localIp, hostPublicKey, hostX25519Key,
               (lastAccessAt IS NULL OR lastAccessAt < datetime('now', '-${LAST_ACCESS_THROTTLE_SEC} seconds')) AS lastAccessStale
        FROM sessions
        WHERE apiKey = ?
      `).bind(apiKey).first());

      if (!row) { sessionMissing = true; return null; }
      // Return host keys even without tunnel for RTC-first connections
      if (!row.tunnelUrl) return { tunnelUrl: null, ...hostKeysOf(row) };

      if (row.lastAccessStale) {
        await withD1Retry(() => env.DB.prepare(`UPDATE sessions SET lastAccessAt = datetime('now') WHERE apiKey = ?`)
          .bind(apiKey).run());
      }
      return { tunnelUrl: row.tunnelUrl, localIp: row.localIp || null, ...hostKeysOf(row) };
    });

    if (sessionMissing) return jsonError("Session not found or expired", 404);
    // Relay-presence verdict, computed at most once per request (a probe wakes
    // the room's Durable Object — don't pay it twice for one login).
    let relayVerdict = null;
    const onRelay = async () => (relayVerdict ??= await agentOnRelay(apiKey, env));
    // Check DO relay for RTC-connected agent when tunnel is unavailable
    if (!cached && !(await onRelay())) return jsonError("Server not ready. Please wait...", 503);

    // Verify agent liveness via heartbeat timestamp and online flag
    const OFFLINE_GRACE_SEC = 300;
    try {
      const liveness = await withD1Retry(() => env.DB.prepare(`
        SELECT
          agentOnline = 0 AS saidGoodbye,
          agentSeenAt IS NOT NULL AND agentSeenAt < datetime('now', '-${OFFLINE_GRACE_SEC} seconds') AS stale
        FROM sessions WHERE apiKey = ?
      `).bind(apiKey).first());
      if (liveness?.saidGoodbye) {
        return jsonError("agent-offline", 503);
      }
      // Stale D1 heartbeat may just be a hiccup — the relay room rescues a live
      // agent. Probed only when the verdict hangs on it (cache-hit or not).
      if (liveness?.stale && !(await onRelay())) {
        return jsonError("agent-offline", 503);
      }
    } catch (e) {
      console.warn(`[connect] liveness check skipped: ${e?.message || e}`);
    }

    const tunnelUrl = cached?.tunnelUrl || null;

    return jsonOk({ tunnelUrl, apiKey, tempKey, localIp: cached?.localIp || null, hostKeys: cached?.hostKeys || null });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
