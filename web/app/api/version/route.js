import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() { return optionsResponse(); }

export async function GET() {
  try {
    const { env } = getCloudflareContext();
    return jsonOk({
      version: env.BUILD_VERSION || "0.1.7",
      buildTime: env.BUILD_TIME || new Date().toISOString(),
      minAppVersion: "0.1.0",
      forceUpdate: false
    });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
