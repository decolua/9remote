import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() { return optionsResponse(); }

export async function DELETE(request) {
  try {
    const { env } = getCloudflareContext();
    const { tempKey } = await request.json();

    if (!tempKey) return jsonError("Missing temp key");

    const normalized = tempKey.toUpperCase();
    const result = await env.DB.prepare(`DELETE FROM temp_keys WHERE temp_key = ?`).bind(normalized).run();

    return jsonOk({ success: true, removed: result.meta.changes > 0 });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
