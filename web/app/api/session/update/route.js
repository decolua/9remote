import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const { apiKey, tunnelUrl, localIp } = await request.json();

    if (!(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key");
    const publicIp = request.headers.get("CF-Connecting-IP") || null;

    await env.DB.prepare(`
      UPDATE sessions SET tunnelUrl = ?, publicIp = ?, localIp = ?, lastAccessAt = datetime('now')
      WHERE apiKey = ?
    `).bind(tunnelUrl, publicIp, localIp || null, apiKey).run();

    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
