import crypto from "crypto";

// CRC secret for legacy v1 keys (must match web API_KEY_SECRET/APP_SECRET).
const API_KEY_SECRET = process.env.API_KEY_SECRET || process.env.APP_SECRET;

function generateKeyId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateCrc(machineId, keyId) {
  if (!API_KEY_SECRET) throw new Error("API_KEY_SECRET not configured (required for v1 keys)");
  return crypto
    .createHmac("sha256", API_KEY_SECRET)
    .update(machineId + keyId)
    .digest("hex")
    .slice(0, 6);
}

export function generateApiKeyWithMachine(machineId) {
  const shortId = machineId.slice(0, 8);
  const keyId = generateKeyId();
  const crc = generateCrc(shortId, keyId);
  const key = `sk-${shortId}-${keyId}-${crc}`;
  return { key, keyId };
}

// v2 keys: sk-{machineId8}-{rand8}-{rand8} (tail is private device secret).
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

// Routing half sent to Worker (head of v2, or full key for v1).
export function headOf(apiKey) {
  if (!isApiKeyV2(apiKey)) return apiKey || null;
  const parts = apiKey.split("-");
  return `${parts[0]}-${parts[1]}-${parts[2]}`;
}

export function tailOf(apiKey) {
  if (!isApiKeyV2(apiKey)) return null;
  return apiKey.split("-")[3];
}

/** Check if presented key matches agent key head (constant-time). */
export function matchesLocalKey(presented, storedKey) {
  if (typeof presented !== "string" || !presented) return false;
  if (typeof storedKey !== "string" || !storedKey) return false;
  const a = Buffer.from(headOf(presented) || "", "utf8");
  const b = Buffer.from(headOf(storedKey) || "", "utf8");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Parse API key and extract machineId + keyId. */
export function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;

  if (isApiKeyV2(apiKey)) {
    const [, machineId, a, b] = apiKey.split("-");
    return { machineId, keyId: a, version: 2, tail: b };
  }

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

export function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length < 8) return "sk-***";
  return `${apiKey.slice(0, 3)}***${apiKey.slice(-4)}`;
}
