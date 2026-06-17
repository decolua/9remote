import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


const TEMP_KEY_LENGTH = 6;
const TEMP_KEY_EXPIRY_MINUTES = 30;
const TEMP_KEY_CHARS = "ABCDEFGHIJKLMNPQRSTUVWXYZ123456789";

function generateTempKey() {
  let result = "";
  for (let i = 0; i < TEMP_KEY_LENGTH; i++) {
    result += TEMP_KEY_CHARS.charAt(Math.floor(Math.random() * TEMP_KEY_CHARS.length));
  }
  return result;
}

export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const { apiKey, expiryMinutes = TEMP_KEY_EXPIRY_MINUTES } = await request.json();

    if (!apiKey || !(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key");

    await env.DB.prepare(`DELETE FROM temp_keys WHERE api_key = ?`).bind(apiKey).run();

    let tempKey;
    for (let i = 0; i < 10; i++) {
      tempKey = generateTempKey();
      const existing = await env.DB.prepare(`SELECT temp_key FROM temp_keys WHERE temp_key = ?`).bind(tempKey).first();
      if (!existing) break;
    }

    const now = Date.now();
    const expiresAt = now + expiryMinutes * 60 * 1000;

    await env.DB.prepare(`INSERT INTO temp_keys (temp_key, api_key, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .bind(tempKey, apiKey, expiresAt, now).run();

    return jsonOk({ tempKey, expiresAt, expiryMinutes });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
