import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { env } = getCloudflareContext();
    const { searchParams } = new URL(request.url);
    const tempKey = searchParams.get("k");

    if (!tempKey) return jsonError("Missing temp key");

    const normalized = tempKey.toUpperCase();
    const row = await env.DB.prepare(`SELECT api_key, expires_at FROM temp_keys WHERE temp_key = ?`)
      .bind(normalized).first();

    if (!row) return jsonError("Invalid temp key", 404);

    if (Date.now() > row.expires_at) {
      await env.DB.prepare(`DELETE FROM temp_keys WHERE temp_key = ?`).bind(normalized).run();
      return jsonError("Temp key expired", 410);
    }

    return jsonOk({ apiKey: row.api_key, tempKey: normalized });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
