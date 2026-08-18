import { getCloudflareContext } from "@opennextjs/cloudflare";
import { withD1Retry, invalidateCache, cacheKeys } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() { return optionsResponse(); }

export async function DELETE(request) {
  try {
    const { env } = getCloudflareContext();
    const { apiKey } = await request.json();
    await withD1Retry(() => env.DB.prepare(`DELETE FROM sessions WHERE apiKey = ?`).bind(apiKey).run());
    // Clears this isolate only; others expire on their own TTL. The signaling gate
    // caches in its own map inside the worker bundle and is not reachable from here
    // — it expires on GATE_CACHE_TTL_MS.
    invalidateCache(cacheKeys.tunnel(apiKey));
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
