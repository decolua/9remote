const API_KEY_SECRET = "9remote-api-key-secret"; // Should match CLI

/**
 * Generate full HMAC hex string for machineId + keyId
 */
async function generateHmac(machineId, keyId) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(API_KEY_SECRET);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = encoder.encode(machineId + keyId);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse API key — supports both formats:
 *   old: sk-{machineId16}-{keyId6}-{crc8}
 *   new: sk-{machineId8}-{keyId4}-{crc6}
 * @param {string} apiKey
 * @returns {{ machineId: string, keyId: string, crc: string } | null}
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
 * Verify API key CRC — accepts both 6-char (new) and 8-char (old) CRC
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
export async function verifyApiKeyCrc(apiKey) {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return false;
  const { machineId, keyId, crc } = parsed;
  const hmac = await generateHmac(machineId, keyId);
  return hmac.slice(0, crc.length) === crc;
}
