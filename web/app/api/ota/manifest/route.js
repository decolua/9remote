import { getCloudflareContext } from "@opennextjs/cloudflare";
import { handleManifestRequest } from "@/features/ota/lib/manifestRoute.js";

// Public OTA manifest endpoint — no auth, consumed by every app install.
// GET only; other methods are rejected by the platform.
export async function GET(request) {
  const { env } = getCloudflareContext();
  // A corrupt DB row (bad manifestJson) must not surface as an unhandled throw
  try {
    return await handleManifestRequest(env, request);
  } catch (err) {
    console.error("[ota] manifest failed:", err?.message || err);
    return new Response(null, { status: 500 });
  }
}
