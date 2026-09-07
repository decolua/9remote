// HMAC verify for apiKey CRC. Secret must come from Workers env (env.API_KEY_SECRET).

async function generateHmac(secret, machineId, keyId) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(machineId + keyId));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse API key format: sk-{machineId8}-{keyId4}-{crc6} (legacy)
 * or v2: sk-{machineId8}-{rand8}-{rand8} — same shape, routing-only, no CRC.
 */
export function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;
  if (/^sk-[a-z0-9]{8}-[a-np-z1-9]{8}-[a-np-z1-9]{8}$/.test(apiKey)) {
    const [, machineId, a, b] = apiKey.split("-");
    return { machineId, keyId: a, version: 2, tail: b };
  }
  // v2 HEAD (what the agent registers and clients present for routing)
  if (/^sk-[a-z0-9]{8}-[a-np-z1-9]{8}$/.test(apiKey)) {
    const [, machineId, a] = apiKey.split("-");
    return { machineId, keyId: a, version: 2 };
  }
  // Legacy CRC is always the first 6 hex chars of the HMAC — anything else is forged.
  const legacy = apiKey.match(/^sk-([a-z0-9]{8})-([a-z0-9]{4})-([0-9a-f]{6})$/);
  if (legacy) return { machineId: legacy[1], keyId: legacy[2], crc: legacy[3] };
  return null;
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

/**
 * Verify API key CRC using env-provided secret
 * @param {string} apiKey
 * @param {object} env - Cloudflare Workers env (contains API_KEY_SECRET or APP_SECRET)
 */
export async function verifyApiKeyCrc(apiKey, env) {
  const secret = env?.API_KEY_SECRET || env?.APP_SECRET;
  if (!secret) throw new Error("API_KEY_SECRET or APP_SECRET not configured");
  const parsed = parseApiKey(apiKey);
  if (!parsed) return false;
  // v2 (full or HEAD) has no CRC — format check in parseApiKey is the whole validation
  if (parsed.version === 2) return true;
  const { machineId, keyId, crc } = parsed;
  const hmac = await generateHmac(secret, machineId, keyId);
  return hmac.slice(0, crc.length) === crc;
}
