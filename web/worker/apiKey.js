// Worker version (no crypto import needed, available globally)

const API_KEY_SECRET = "9remote-api-key-secret"; // Should match CLI

/**
 * Generate CRC (8-char HMAC)
 */
async function generateCrc(machineId, keyId) {
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
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 8);
}

/**
 * Parse API key and extract machineId + keyId
 * Format: sk-{machineId}-{keyId}-{crc8}
 * @param {string} apiKey
 * @returns {{ machineId: string, keyId: string } | null}
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
 * Verify API key CRC
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
export async function verifyApiKeyCrc(apiKey) {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return false;
  
  const { machineId, keyId, crc } = parsed;
  const expectedCrc = await generateCrc(machineId, keyId);
  
  return crc === expectedCrc;
}
