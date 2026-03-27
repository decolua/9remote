import crypto from "crypto";

const API_KEY_SECRET = process.env.API_KEY_SECRET || "9remote-api-key-secret";

/**
 * Generate 4-char random keyId
 */
function generateKeyId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate CRC (6-char HMAC)
 */
function generateCrc(machineId, keyId) {
  return crypto
    .createHmac("sha256", API_KEY_SECRET)
    .update(machineId + keyId)
    .digest("hex")
    .slice(0, 6);
}

/**
 * Generate API key with machineId embedded
 * Format: sk-{machineId8}-{keyId4}-{crc6}
 * @param {string} machineId - machine ID (uses first 8 chars)
 * @returns {{ key: string, keyId: string }}
 */
export function generateApiKeyWithMachine(machineId) {
  const shortId = machineId.slice(0, 8);
  const keyId = generateKeyId();
  const crc = generateCrc(shortId, keyId);
  const key = `sk-${shortId}-${keyId}-${crc}`;
  return { key, keyId };
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
    
    const expectedCrc = generateCrc(machineId, keyId);
    if (crc !== expectedCrc) return null;
    
    return { machineId, keyId };
  }
  
  return null;
}

/**
 * Verify API key CRC — supports both old (16+6+8) and new (8+4+6) format
 */

/**
 * Verify API key CRC
 * @param {string} apiKey
 * @returns {boolean}
 */
export function verifyApiKeyCrc(apiKey) {
  const parsed = parseApiKey(apiKey);
  return parsed !== null;
}
