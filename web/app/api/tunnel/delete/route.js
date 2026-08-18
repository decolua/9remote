import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { deleteTunnel } from "@/shared/utils/tunnelService";
import { withD1Retry, invalidateCache, cacheKeys } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";

export function OPTIONS() { return optionsResponse(); }

export async function DELETE(request) {
  try {
    const { env } = getCloudflareContext();
    const { apiKey } = await request.json();

    if (!(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key");

    // Primary: this tunnelId is passed straight to the Cloudflare delete API —
    // a stale read would target a tunnel that is no longer the current one.
    const session = await withD1Retry(() => env.DB
      .prepare(`SELECT tunnelId, shortId FROM sessions WHERE apiKey = ?`).bind(apiKey).first());

    if (session?.tunnelId) {
      await deleteTunnel(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_KEY, env.CLOUDFLARE_EMAIL, session.tunnelId, session.shortId);
      await withD1Retry(() => env.DB.prepare(`UPDATE sessions SET tunnelId = NULL, tunnelUrl = NULL WHERE apiKey = ?`).bind(apiKey).run());
      invalidateCache(cacheKeys.tunnel(apiKey));
    }

    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
