// OTA manifest request handler — Expo Updates protocol v1.
// Kept framework-agnostic (takes env + Request, returns Response) so it is
// unit-testable without spinning up the Next/OpenNext runtime.
import { resolveActiveUpdate } from "./updateService.js";
import { buildMultipart } from "./manifest.js";
import { MANIFEST_CACHE_CONTROL } from "../constants/index.js";

const COMMON_HEADERS = {
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
  "cache-control": MANIFEST_CACHE_CONTROL
};

const VALID_PLATFORMS = new Set(["ios", "android"]);

export async function handleManifestRequest(env, request) {
  const platform = request.headers.get("expo-platform");
  const runtimeVersion = request.headers.get("expo-runtime-version");
  const channel = request.headers.get("expo-channel-name") || env.OTA_DEFAULT_CHANNEL || "production";
  const currentUpdateId = request.headers.get("expo-current-update-id");

  if (!VALID_PLATFORMS.has(platform)) return new Response(null, { status: 400 });
  if (!runtimeVersion) return new Response(null, { status: 400 });

  const updateGroup = await resolveActiveUpdate(env, { channel, runtimeVersion, platform });

  const headers = new Headers(COMMON_HEADERS);

  if (!updateGroup) return new Response(null, { status: 204, headers });

  // Re-serving the same id makes the client download in a loop
  if (currentUpdateId && currentUpdateId === updateGroup.id) {
    return new Response(null, { status: 204, headers });
  }

  const manifest = updateGroup.manifestJson;
  // Corrupt row — parseRow falls back to {} so assets/launchAsset are missing.
  // Serve "no update" instead of throwing on the spread below.
  if (!Array.isArray(manifest?.assets) || !manifest.launchAsset) {
    return new Response(null, { status: 204, headers });
  }
  const manifestBody = updateGroup.manifestString;
  const signature = updateGroup.signature || null;

  const assetRequestHeaders = {};
  for (const a of [...manifest.assets, manifest.launchAsset]) {
    assetRequestHeaders[a.key] = {};
  }
  const extensionsBody = JSON.stringify({ assetRequestHeaders });

  const { boundary, body } = buildMultipart([
    { name: "manifest", contentType: "application/json", body: manifestBody, signature },
    { name: "extensions", contentType: "application/json", body: extensionsBody }
  ]);

  headers.set("content-type", `multipart/mixed; boundary=${boundary}`);
  return new Response(body, { status: 200, headers });
}
