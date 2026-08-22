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

// v2 keys: sk-{machineId8}-{rand8}-{rand8} — same shape as legacy so the UI
// reads identically, but both tail segments are real random (~41 bit each, no
// CRC-with-public-secret). The key is routing-only ("room number"); agent
// entry requires the per-device secret (lib/deviceAuth).
const KEY_V2_CHARS = "abcdefghijklmnpqrstuvwxyz123456789";
const KEY_V2_SEGMENT = 8;

function randomSegment() {
  let s = "";
  for (let i = 0; i < KEY_V2_SEGMENT; i++) {
    s += KEY_V2_CHARS[crypto.randomInt(KEY_V2_CHARS.length)];
  }
  return s;
}

export function generateApiKeyV2(machineId) {
  const shortId = (machineId || "").slice(0, 8).toLowerCase();
  return `sk-${shortId}-${randomSegment()}-${randomSegment()}`;
}

export function isApiKeyV2(apiKey) {
  return /^sk-[a-z0-9]{8}-[a-np-z1-9]{8}-[a-np-z1-9]{8}$/.test(apiKey || "");
}

// HEAD = the part that may travel to the Worker (routing only). v2 keys keep
// their TAIL (last segment) off the network entirely; v1 keys have no split
// and pass through unchanged.
export function headOf(apiKey) {
  if (!isApiKeyV2(apiKey)) return apiKey || null;
  const parts = apiKey.split("-");
  return `${parts[0]}-${parts[1]}-${parts[2]}`;
}

// TAIL = the private half of a v2 key (null for legacy keys)
export function tailOf(apiKey) {
  if (!isApiKeyV2(apiKey)) return null;
  return apiKey.split("-")[3];
}

/**
 * Does a presented key belong to THIS agent?
 *
 * The tunnel-facing HTTP routes have no device-auth handshake to lean on, so
 * they compare here. Shape is not identity: a v2 key carries no CRC, and the
 * pattern check that stood in for verification accepted any string matching it.
 *
 * Compared on the HEAD, because that is what clients present — useAuth stores
 * headOf(key) and the tail never leaves the browser. So this establishes "holds
 * the head of this agent's current key", which is what these routes can ask for
 * without putting the tail in an HTTP header.
 */
export function matchesLocalKey(presented, storedKey) {
  if (typeof presented !== "string" || !presented || !storedKey) return false;
  const a = Buffer.from(headOf(presented) || "", "utf8");
  const b = Buffer.from(headOf(storedKey) || "", "utf8");
  // Length guard first — timingSafeEqual throws when the two differ.
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Parse API key and extract machineId + keyId
 * Format: sk-{machineId}-{keyId}-{crc8}
 * @param {string} apiKey
 * @returns {{ machineId: string, keyId: string } | null}
 */
export function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;

  // Both v1 and v2 are 4 dash-segments — v2 is identified by its 8-char tail
  // segments (legacy keyId is 4 chars).
  if (isApiKeyV2(apiKey)) {
    const [, machineId, a, b] = apiKey.split("-");
    return { machineId, keyId: a, version: 2, tail: b };
  }

  // v2 HEAD (what gets registered with the Worker)
  if (/^sk-[a-z0-9]{8}-[a-np-z1-9]{8}$/.test(apiKey)) {
    const [, machineId, a] = apiKey.split("-");
    return { machineId, keyId: a, version: 2 };
  }

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
 * Mask API key for safe logging (preserve prefix + suffix)
 */
export function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length < 8) return "sk-***";
  return `${apiKey.slice(0, 3)}***${apiKey.slice(-4)}`;
}
