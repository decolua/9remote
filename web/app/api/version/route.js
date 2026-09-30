import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { env } = getCloudflareContext();
    // Per-platform minimums so forcing an Android update never blocks iOS
    const platform = new URL(request.url).searchParams.get("platform") === "ios" ? "ios" : "android";
    return jsonOk({
      version: env.BUILD_VERSION || "2.4.0",
      buildTime: env.BUILD_TIME || new Date().toISOString(),
      minAppVersion: (platform === "ios" ? env.MIN_APP_VERSION_IOS : env.MIN_APP_VERSION_ANDROID) || "0.0.0",
      forceUpdate: false
    });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
