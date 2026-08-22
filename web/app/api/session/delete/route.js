import { getCloudflareContext } from "@opennextjs/cloudflare";
import { withD1Retry, invalidateCache, cacheKeys } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { checkMutationAuth } from "@/shared/utils/sessionMutationAuth";


export function OPTIONS() { return optionsResponse(); }

export async function DELETE(request) {
  try {
    const { env } = getCloudflareContext();
    const body = await request.json();
    const { apiKey } = body;

    // This route had no check at all: the HEAD is public, so knowing one was
    // enough to delete someone else's session and take their agent offline.
    const row = await withD1Retry(() => env.DB.prepare(
      "SELECT hostPublicKey FROM sessions WHERE apiKey = ?"
    ).bind(apiKey).first());
    const auth = await checkMutationAuth({ storedPublicKey: row?.hostPublicKey, body });
    if (!auth.ok) return jsonError(`Unauthorized: ${auth.reason}`, 403);

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
