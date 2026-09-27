/**
 * Parse API key format: sk-{machineId8}-{rand8}-{rand8}, full or HEAD.
 * The HEAD (first two segments) is what the host registers and clients
 * present for routing — both shapes are valid at every trust boundary.
 */
export function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;
  if (/^sk-[a-z0-9]{8}-[a-np-z1-9]{8}-[a-np-z1-9]{8}$/.test(apiKey)) {
    const [, machineId, a, b] = apiKey.split("-");
    return { machineId, keyId: a, version: 2, tail: b };
  }
  if (/^sk-[a-z0-9]{8}-[a-np-z1-9]{8}$/.test(apiKey)) {
    const [, machineId, a] = apiKey.split("-");
    return { machineId, keyId: a, version: 2 };
  }
  return null;
}

/** A v1 key: sk-{machineId8}-{keyId4}-{crc6}. Shape-only — enough to tell its
 *  holder to update the host, which is all it is good for now. */
export function isLegacyApiKey(apiKey) {
  if (typeof apiKey !== "string" || !apiKey) return false;
  return /^sk-[a-z0-9]{8}-[a-z0-9]{4}-[0-9a-f]{6}$/.test(apiKey.trim().toLowerCase());
}

/** HEAD of a v2 key (routing part); v1 keys pass through unchanged. */
export function headOf(apiKey) {
  if (typeof apiKey !== "string" || !/^sk-[a-z0-9]{8}-[a-np-z1-9]{8}-[a-np-z1-9]{8}$/.test(apiKey)) return apiKey || null;
  const parts = apiKey.split("-");
  return `${parts[0]}-${parts[1]}-${parts[2]}`;
}

/** TAIL of a v2 key; null for legacy keys. */
export function tailOf(apiKey) {
  if (typeof apiKey !== "string" || !/^sk-[a-z0-9]{8}-[a-np-z1-9]{8}-[a-np-z1-9]{8}$/.test(apiKey)) return null;
  return apiKey.split("-")[3];
}

/** Route lookups speak HEAD — a client may still present a full v2 key
 *  (cached old web, manual paste), so normalize before any D1 compare. */
export function normalizeApiKey(apiKey) {
  return headOf(apiKey);
}

/** Accepted at every API trust boundary: a v2 key, full or HEAD.
 *  v1 is retired — a host still holding one must update to connect. */
export function isAcceptedApiKey(apiKey) {
  return parseApiKey(apiKey)?.version === 2;
}
