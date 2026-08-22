import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { withD1Retry, invalidateCache, cacheKeys } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { checkMutationAuth } from "@/shared/utils/sessionMutationAuth";


export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const body = await request.json();
    const { apiKey, tunnelUrl, localIp } = body;

    if (!(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key");

    // The apiKey here is the HEAD, which is public routing data — on its own it
    // says nothing about who is calling. Where the agent has registered a host
    // key, only its signature may repoint this session.
    const row = await withD1Retry(() => env.DB.prepare(
      "SELECT hostPublicKey FROM sessions WHERE apiKey = ?"
    ).bind(apiKey).first());
    const auth = await checkMutationAuth({ storedPublicKey: row?.hostPublicKey, body });
    if (!auth.ok) return jsonError(`Unauthorized: ${auth.reason}`, 403);

    const publicIp = request.headers.get("CF-Connecting-IP") || null;

    await withD1Retry(() => env.DB.prepare(`
      UPDATE sessions SET tunnelUrl = ?, publicIp = ?, localIp = ?, lastAccessAt = datetime('now')
      WHERE apiKey = ?
    `).bind(tunnelUrl, publicIp, localIp || null, apiKey).run());

    // cloudflared restarts hand out a new trycloudflare URL — a stale cached one
    // would point every client at a dead tunnel for the rest of the TTL.
    invalidateCache(cacheKeys.tunnel(apiKey));

    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
