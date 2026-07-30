import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { publishUpdate } from "@/features/ota/lib/updateService.js";

export function OPTIONS() { return optionsResponse(); }

// Internal publish endpoint — guarded by a static token (not admin auth).
// Called by the expo/scripts/ota/publish.js CLI after uploading assets to R2.
export async function POST(request) {
  try {
    const { env } = getCloudflareContext();

    const token = request.headers.get("x-ota-token");
    if (!env.OTA_PUBLISH_TOKEN || token !== env.OTA_PUBLISH_TOKEN) {
      return jsonError("Invalid OTA token", 401);
    }

    const payload = await request.json();
    const updateGroup = await publishUpdate(env, payload);
    return jsonOk({ success: true, id: updateGroup.id, buildNumber: updateGroup.buildNumber });
  } catch (e) {
    return jsonError(e?.message || String(e), 400);
  }
}
