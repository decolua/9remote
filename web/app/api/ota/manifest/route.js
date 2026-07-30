import { getCloudflareContext } from "@opennextjs/cloudflare";
import { handleManifestRequest } from "@/features/ota/lib/manifestRoute.js";

// Public OTA manifest endpoint — no auth, consumed by every app install.
// GET only; other methods are rejected by the platform.
export async function GET(request) {
  const { env } = getCloudflareContext();
  return handleManifestRequest(env, request);
}
