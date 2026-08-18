import { getCloudflareContext } from "@opennextjs/cloudflare";
import { parseApiKey, verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { createTunnel } from "@/shared/utils/tunnelService";
import { withD1Retry, invalidateCache, cacheKeys } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";

export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const { apiKey } = await request.json();

    if (!(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key");
    const { machineId } = parseApiKey(apiKey);

    // Primary: the agent calls session/create immediately before this, and a
    // lagging replica would report the row as missing shortId.
    const session = await withD1Retry(() => env.DB
      .prepare(`SELECT shortId FROM sessions WHERE apiKey = ?`).bind(apiKey).first());
    if (!session?.shortId) return jsonError("Session missing shortId");

    const { tunnelId, token, hostname } = await createTunnel(
      env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_KEY, env.CLOUDFLARE_EMAIL,
      machineId, session.shortId
    );

    await withD1Retry(() => env.DB.prepare(`UPDATE sessions SET tunnelId = ?, tunnelUrl = ?, lastAccessAt = datetime('now') WHERE apiKey = ?`)
      .bind(tunnelId, hostname, apiKey).run());

    invalidateCache(cacheKeys.tunnel(apiKey));

    return jsonOk({ tunnelId, token, hostname });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
