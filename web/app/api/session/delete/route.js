import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() { return optionsResponse(); }

export async function DELETE(request) {
  try {
    const { env } = getCloudflareContext();
    const { apiKey } = await request.json();
    await env.DB.prepare(`DELETE FROM sessions WHERE apiKey = ?`).bind(apiKey).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
