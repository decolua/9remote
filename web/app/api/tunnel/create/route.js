import { getCloudflareContext } from "@opennextjs/cloudflare";
import { parseApiKey, verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { createTunnel } from "@/shared/utils/tunnelService";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";

export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const { apiKey } = await request.json();

    if (!(await verifyApiKeyCrc(apiKey))) return jsonError("Invalid API key");
    const { machineId } = parseApiKey(apiKey);

    const session = await env.DB.prepare(`SELECT shortId FROM sessions WHERE apiKey = ?`).bind(apiKey).first();
    if (!session?.shortId) return jsonError("Session missing shortId");

    const { tunnelId, token, hostname } = await createTunnel(
      env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_KEY, env.CLOUDFLARE_EMAIL,
      machineId, session.shortId
    );

    await env.DB.prepare(`UPDATE sessions SET tunnelId = ?, tunnelUrl = ?, lastAccessAt = datetime('now') WHERE apiKey = ?`)
      .bind(tunnelId, hostname, apiKey).run();

    return jsonOk({ tunnelId, token, hostname });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
