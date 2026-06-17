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
 * Parse API key format: sk-{machineId8}-{keyId4}-{crc6}
 */
export function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;
  const parts = apiKey.split("-");
  if (parts.length === 4) {
    const [, machineId, keyId, crc] = parts;
    return { machineId, keyId, crc };
  }
  return null;
}

/**
 * Verify API key CRC using env-provided secret
 * @param {string} apiKey
 * @param {object} env - Cloudflare Workers env (must contain API_KEY_SECRET)
 */
export async function verifyApiKeyCrc(apiKey, env) {
  if (!env?.API_KEY_SECRET) throw new Error("API_KEY_SECRET not configured");
  const parsed = parseApiKey(apiKey);
  if (!parsed) return false;
  const { machineId, keyId, crc } = parsed;
  const hmac = await generateHmac(env.API_KEY_SECRET, machineId, keyId);
  return hmac.slice(0, crc.length) === crc;
}
