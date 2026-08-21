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
        SELECT tunnelUrl, machineId, publicIp, localIp,
               (lastAccessAt IS NULL OR lastAccessAt < datetime('now', '-${LAST_ACCESS_THROTTLE_SEC} seconds')) AS lastAccessStale
        FROM sessions
        WHERE apiKey = ?
      `).bind(apiKey).first());

      // Both failure modes return null so neither is cached: a session row and a
      // tunnelUrl can both appear seconds later, and a cached miss would hide them.
      if (!row) { sessionMissing = true; return null; }
      if (!row.tunnelUrl) return null;

      if (row.lastAccessStale) {
        await withD1Retry(() => env.DB.prepare(`UPDATE sessions SET lastAccessAt = datetime('now') WHERE apiKey = ?`)
          .bind(apiKey).run());
      }
      return { tunnelUrl: row.tunnelUrl, localIp: row.localIp || null };
    });

    if (sessionMissing) return jsonError("Session not found or expired", 404);
    if (!cached) return jsonError("Server not ready. Please wait...", 503);

    console.log(`[connect] apiKey=${apiKey?.slice(0,8)} tunnelUrl=${cached.tunnelUrl} localIp=${cached.localIp || "none"}`);

    return jsonOk({ tunnelUrl: cached.tunnelUrl, apiKey, tempKey, localIp: cached.localIp });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
