import { getCloudflareContext } from "@opennextjs/cloudflare";
import { parseApiKey, verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { withD1Retry, invalidateCache, cacheKeys } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
  const { env } = getCloudflareContext();
  const { apiKey, shortId } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key");
  const { machineId } = parseApiKey(apiKey);

  await withD1Retry(() => env.DB.prepare(`
    INSERT INTO sessions (machineId, apiKey, shortId, tunnelUrl, lastAccessAt, expiresAt)
    VALUES (?, ?, ?, NULL, datetime('now'), datetime('now', '+7 days'))
    ON CONFLICT(apiKey)
    DO UPDATE SET
      shortId = COALESCE(shortId, excluded.shortId),
      lastAccessAt = datetime('now'),
      expiresAt = datetime('now', '+7 days')
  `).bind(machineId, apiKey, shortId || null).run());

  // A restart reuses the apiKey but drops the old tunnelUrl — clear the cache so
  // clients do not keep resolving to the previous run's tunnel.
  invalidateCache(cacheKeys.tunnel(apiKey));

  return jsonOk({ success: true, machineId });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
