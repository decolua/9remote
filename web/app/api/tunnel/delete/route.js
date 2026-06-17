import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { deleteTunnel } from "@/shared/utils/tunnelService";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";

export function OPTIONS() { return optionsResponse(); }

export async function DELETE(request) {
  try {
    const { env } = getCloudflareContext();
    const { apiKey } = await request.json();

    if (!(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key");

    const session = await env.DB.prepare(`SELECT tunnelId, shortId FROM sessions WHERE apiKey = ?`).bind(apiKey).first();

    if (session?.tunnelId) {
      await deleteTunnel(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_KEY, env.CLOUDFLARE_EMAIL, session.tunnelId, session.shortId);
      await env.DB.prepare(`UPDATE sessions SET tunnelId = NULL, tunnelUrl = NULL WHERE apiKey = ?`).bind(apiKey).run();
    }

    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
