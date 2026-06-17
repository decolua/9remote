import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { decryptToken } from "@/shared/utils/token";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const body = await request.json();
    let apiKey;
    let tempKey = body.tempKey || null;

    if (body.token) {
      if (body.token.length <= 10 && /^[A-Z0-9]+$/i.test(body.token)) {
        const normalized = body.token.toUpperCase();
        const row = await env.DB.prepare(
          `SELECT api_key, expires_at FROM temp_keys WHERE temp_key = ?`
        ).bind(normalized).first();

        if (!row) return jsonError("Invalid or expired temp key", 401);
        if (Date.now() > row.expires_at) {
          await env.DB.prepare(`DELETE FROM temp_keys WHERE temp_key = ?`).bind(normalized).run();
          return jsonError("Temp key expired", 410);
        }
        apiKey = row.api_key;
        tempKey = normalized;
      } else {
        const payload = decryptToken(body.token, env);
        if (!payload) return jsonError("Invalid or expired token", 401);
        apiKey = payload.key;
      }
    } else if (body.apiKey) {
      apiKey = body.apiKey;
    } else {
      return jsonError("Missing token or apiKey");
    }

    if (!(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key", 401);

    const session = await env.DB.prepare(`
      SELECT tunnelUrl, machineId, publicIp, localIp FROM sessions
      WHERE apiKey = ? AND expiresAt > datetime('now')
    `).bind(apiKey).first();

    if (!session) return jsonError("Session not found or expired", 404);
    if (!session.tunnelUrl) return jsonError("Server not ready. Please wait...", 503);

    await env.DB.prepare(`UPDATE sessions SET lastAccessAt = datetime('now') WHERE apiKey = ?`)
      .bind(apiKey).run();

    return jsonOk({ tunnelUrl: session.tunnelUrl, apiKey, tempKey, localIp: session.localIp || null });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
