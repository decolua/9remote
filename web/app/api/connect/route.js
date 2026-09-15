import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc, normalizeApiKey } from "@/shared/utils/apiKey";
import { decryptToken } from "@/shared/utils/token";
import { withD1Retry, cachedLookup, cacheKeys, CACHE_TTL } from "@/shared/utils/db";
import { RATE_LIMITS, clientIp, isRateLimited, recordFailure, clearFailures } from "@/shared/utils/rateLimit";
import { jsonOk, jsonError, jsonRateLimited, optionsResponse } from "@/shared/utils/apiResponse";

// Skip the lastAccessAt write when fresher than this — cuts the most frequent
// D1 write (every connect/reconnect) with at most 60s skew for stats.
const LAST_ACCESS_THROTTLE_SEC = 60;
const SCOPE = "connect";
// Bounded: this sits on the login path, and a DO that never answers must cost
// the user a retryable error, not a spinner. Fails closed — the client falls
// back to the 503 it would have got anyway.
const RELAY_PROBE_TIMEOUT_MS = 3000;

// The host keys ride along so a client that never established RTC — and so never
// pinned anything — can still seal its tail. They arrive from the Worker, which is
// not a trusted source: the client compares fp2 over the pair against the two
// characters read off the agent's screen before believing them.
const hostKeysOf = (row) => ({
  hostKeys: row.hostPublicKey ? { ed: row.hostPublicKey, x: row.hostX25519Key || null } : null
});

/** Is an agent joined to this key's signaling room? The DO knows; nobody else does.
 *  Addressed straight to the room's DO, not through the public /signaling gate —
 *  this route has already resolved the session row, so the gate's sessionExists
 *  would only repeat a lookup. The DO's fetch matches the bare /presence path,
 *  which is what the public gate rewrites to as well. */
async function agentOnRelay(apiKey, env) {
  try {
    const res = await env.SIGNALING_DO.get(env.SIGNALING_DO.idFromName(apiKey))
      .fetch(new Request("https://do/presence", { signal: AbortSignal.timeout(RELAY_PROBE_TIMEOUT_MS) }));
    const { agentPresent } = await res.json();
    return agentPresent === true;
  } catch (e) {
    console.warn(`[connect] relay probe failed: ${e?.message || e}`);
    return false;
  }
}

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const ip = clientIp(request);
    // Only failed credentials count, so the reconnect storms this route sees from
    // healthy clients (valid apiKey, many requests/min) never trip this.
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
        // Expired but real — a slow user, not a guesser. Not counted.
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

    // The CRC is only 24 bits, so this check alone is brute-forceable in ~16M
    // tries. Counting each failure is what makes walking that space impractical.
    if (!(await verifyApiKeyCrc(apiKey, env))) {
      await recordFailure(SCOPE, ip, RATE_LIMITS.connect, env.LOGIN_RATE_LIMITER);
      return jsonError("Invalid API key", 401);
    }

    // v2 keys are stored/looked up by HEAD — normalize a full-key presentation
    apiKey = normalizeApiKey(apiKey);

    clearFailures(SCOPE, ip);

    // Reconnect storms replay this route constantly; a cache hit answers without
    // touching D1 at all. Only a resolved tunnelUrl is cached — "not ready yet"
    // must keep re-reading, and tunnel/session writes drop the key on change.
    let sessionMissing = false;
    const cached = await cachedLookup(cacheKeys.tunnel(apiKey), CACHE_TTL.tunnelSec, async () => {
      // Primary, not a replica: this read repopulates the cache right after an
      // invalidation, so a lagging replica would pin the previous tunnelUrl for a
      // full TTL — exactly the URL the invalidation existed to drop.
      const row = await withD1Retry(() => env.DB.prepare(`
        SELECT tunnelUrl, machineId, publicIp, localIp, hostPublicKey, hostX25519Key,
               (lastAccessAt IS NULL OR lastAccessAt < datetime('now', '-${LAST_ACCESS_THROTTLE_SEC} seconds')) AS lastAccessStale
        FROM sessions
        WHERE apiKey = ?
      `).bind(apiKey).first());

      // Both failure modes return null so neither is cached: a session row and a
      // tunnelUrl can both appear seconds later, and a cached miss would hide them.
      if (!row) { sessionMissing = true; return null; }
      // The host keys are carried even with no tunnel. RTC-first means the very
      // first connection can have no tunnel at all, and that is exactly the one
      // where the tail most needs sealing — dropping the keys here would send a
      // pairing secret in the clear on the connection that most needs it sealed.
      if (!row.tunnelUrl) return { tunnelUrl: null, ...hostKeysOf(row) };

      if (row.lastAccessStale) {
        await withD1Retry(() => env.DB.prepare(`UPDATE sessions SET lastAccessAt = datetime('now') WHERE apiKey = ?`)
          .bind(apiKey).run());
      }
      return { tunnelUrl: row.tunnelUrl, localIp: row.localIp || null, ...hostKeysOf(row) };
    });

    if (sessionMissing) return jsonError("Session not found or expired", 404);
    // No tunnel is not the same as no carrier: the DO relay serves clients over
    // RTC, with no cloudflared involved. Ask the room whether an agent is on it
    // before refusing a login the client could have completed.
    // An agent sitting on the relay also outranks the heartbeat below: the DO
    // socket is live proof, agentSeenAt only says the last HTTP beat succeeded —
    // and a beat that fails while signaling still works must not read as offline.
    const onRelay = !cached && await agentOnRelay(apiKey, env);
    if (!cached && !onRelay) return jsonError("Server not ready. Please wait...", 503);

    // Liveness gate: an agent that heartbeats keeps agentSeenAt fresh, and its
    // shutdown sets agentOnline=0. Stale or said-goodbye means the machine is
    // down — fail login with the marker the web UI localises, instead of
    // handing out a dead tunnel the client spins on forever. NULL columns =
    // a pre-heartbeat agent: unknown, not offline. Fails open on a schema
    // without the columns (migration not applied yet).
    const OFFLINE_GRACE_SEC = 300; // ≥ 2× the agent's 120s beat — absorbs slow nets
    try {
      const liveness = await withD1Retry(() => env.DB.prepare(`
        SELECT
          agentOnline = 0 AS saidGoodbye,
          agentSeenAt IS NOT NULL AND agentSeenAt < datetime('now', '-${OFFLINE_GRACE_SEC} seconds') AS stale
        FROM sessions WHERE apiKey = ?
      `).bind(apiKey).first());
      // saidGoodbye is explicit — a shutdown, and the relay would be empty anyway
      // if it had taken effect. Only the stale beat is overruled by live presence.
      if (liveness?.saidGoodbye || (liveness?.stale && !onRelay)) {
        return jsonError("agent-offline", 503);
      }
    } catch (e) {
      console.warn(`[connect] liveness check skipped: ${e?.message || e}`);
    }

    // A cached tunnel URL wins: if the tunnel is up, WS is the better carrier and
    // the client should try it first. Without one, RTC over the relay is the only
    // remaining carrier, so the answer the client gets is a login with no URL.
    const tunnelUrl = cached?.tunnelUrl || null;

    console.log(`[connect] apiKey=${apiKey?.slice(0,8)} tunnelUrl=${tunnelUrl || "none (rtc)"} localIp=${cached?.localIp || "none"}` +
      // TEMP DIAGNOSTIC — sealing rollout; remove once verified end to end
      ` [seal] hostKeys=${cached?.hostKeys ? (cached.hostKeys.x ? "ed+x" : "ed only (agent has not registered a sealing key)") : "none"}`);

    return jsonOk({ tunnelUrl, apiKey, tempKey, localIp: cached?.localIp || null, hostKeys: cached?.hostKeys || null });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
