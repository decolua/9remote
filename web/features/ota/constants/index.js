// OTA Updates — Expo Updates protocol v1 (self-hosted, replaces u.expo.dev)
// Centralized config consumed by the manifest/publish endpoints and the
// update service. Env-driven; no hardcoded values.

const OTA_API = {
  manifest: "/api/ota/manifest",
  publish: "/api/ota/publish",
  admin: "/api/admin/ota"
};

// R2 public base url used to build asset urls inside the manifest.
// The bucket itself is served from a subdomain (e.g. r2.9remote.cc), not read
// through the Worker — only the manifest is computed here.
export const R2_DEFAULT_BASE = "https://r2.9remote.cc";

// SFV signature algorithm the client expects (matches expo-updates defaults)
export const SIGN_ALG = "rsa-v1_5-sha256";

// KV is invalidated explicitly on every publish/promote; the TTL is only a
// safety net so a missed invalidation cannot serve a stale manifest forever.
export const KV_CACHE_TTL_SECONDS = 3600;

// cache-control: manifest must never be cached — a stale manifest freezes
// devices on the old update even after a publish.
export const MANIFEST_CACHE_CONTROL = "private, max-age=0, no-cache, no-store, must-revalidate";

export { OTA_API };
