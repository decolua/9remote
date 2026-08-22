import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc, normalizeApiKey } from "@/shared/utils/apiKey";
import { withD1Retry } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { checkMutationAuth } from "@/shared/utils/sessionMutationAuth";


const TEMP_KEY_LENGTH = 6;
const TEMP_KEY_EXPIRY_MINUTES = 30;
const TEMP_KEY_CHARS = "ABCDEFGHIJKLMNPQRSTUVWXYZ123456789";

// Largest multiple of the alphabet size that fits in a byte. Bytes at or above it
// are discarded rather than folded with %, which would make the first
// 256 % 34 characters measurably more likely and shrink the effective key space.
const REJECTION_CEILING = 256 - (256 % TEMP_KEY_CHARS.length);

// crypto.getRandomValues, not Math.random: this key is a credential, and
// Math.random is a predictable PRNG whose output stream can be reconstructed from
// enough observed values — which for short keys means guessing future ones.
function generateTempKey() {
  let result = "";
  while (result.length < TEMP_KEY_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(TEMP_KEY_LENGTH));
    for (const byte of bytes) {
      if (byte >= REJECTION_CEILING) continue;
      result += TEMP_KEY_CHARS[byte % TEMP_KEY_CHARS.length];
      if (result.length === TEMP_KEY_LENGTH) break;
    }
  }
  return result;
}

export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const body = await request.json();
    const { apiKey, expiryMinutes = TEMP_KEY_EXPIRY_MINUTES } = body;

    if (!apiKey || !(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key");
    const session = await withD1Retry(() => env.DB.prepare(
      "SELECT hostPublicKey FROM sessions WHERE apiKey = ?"
    ).bind(normalizeApiKey(apiKey)).first());
    if (!session) return jsonError("Invalid API key");

    // A pairing code is what session/create accepts as proof that someone is at
    // the machine, so minting one must itself be proof of the same thing. The
    // HEAD is public: without this, anyone holding one could mint a code for
    // someone else's agent and use it to replace their registered host key.
    const auth = await checkMutationAuth({ storedPublicKey: session.hostPublicKey, body });
    if (!auth.ok) return jsonError(`Unauthorized: ${auth.reason}`, 403);

    await withD1Retry(() => env.DB.prepare(`DELETE FROM temp_keys WHERE api_key = ?`).bind(apiKey).run());

    const now = Date.now();
    const expiresAt = now + expiryMinutes * 60 * 1000;
    let tempKey;
    for (let i = 0; i < 10; i++) {
      tempKey = generateTempKey();
      // PK collision → changes = 0 → try another key (single query per attempt)
      const res = await withD1Retry(() => env.DB.prepare(
        `INSERT OR IGNORE INTO temp_keys (temp_key, api_key, expires_at, created_at) VALUES (?, ?, ?, ?)`
      ).bind(tempKey, apiKey, expiresAt, now).run());
      if (res.meta.changes > 0) break;
    }

    return jsonOk({ tempKey, expiresAt, expiryMinutes });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
