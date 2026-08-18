import { getCloudflareContext } from "@opennextjs/cloudflare";
import { withD1Retry } from "@/shared/utils/db";
import { RATE_LIMITS, clientIp, isRateLimited, recordFailure, clearFailures } from "@/shared/utils/rateLimit";
import { jsonOk, jsonError, jsonRateLimited, optionsResponse } from "@/shared/utils/apiResponse";

const SCOPE = "tempKeyVerify";
// 6 chars over a 34-char alphabet is ~1.5B combinations, but an attacker only has
// to hit ANY live key, so the real search space shrinks with the number of active
// keys. Blocking failures is what keeps that search from being walked.
// Mirrors TEMP_KEY_CHARS in temp-key/create: no O and no 0 (confusable when read
// off a screen), so anything containing them is impossible and rejected for free.
const TEMP_KEY_PATTERN = /^[A-NP-Z1-9]{6}$/;

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { env } = getCloudflareContext();
    const ip = clientIp(request);
    if (isRateLimited(SCOPE, ip, RATE_LIMITS.tempKeyVerify)) {
      return jsonRateLimited(RATE_LIMITS.tempKeyVerify.windowSec);
    }

    const { searchParams } = new URL(request.url);
    const tempKey = searchParams.get("k");

    if (!tempKey) return jsonError("Missing temp key");

    const normalized = tempKey.toUpperCase();
    // Malformed keys can never match a row — reject them without a D1 round-trip,
    // and still count them so a scanner burns its budget on the cheap path.
    if (!TEMP_KEY_PATTERN.test(normalized)) {
      await recordFailure(SCOPE, ip, RATE_LIMITS.tempKeyVerify, env.LOGIN_RATE_LIMITER);
      return jsonError("Invalid temp key", 404);
    }
    // Primary, not a read replica: the key is minutes old at most and a replica
    // that has not caught up would reject a QR the user just scanned.
    const row = await withD1Retry(() => env.DB.prepare(`SELECT api_key, expires_at FROM temp_keys WHERE temp_key = ?`)
      .bind(normalized).first());

    if (!row) {
      await recordFailure(SCOPE, ip, RATE_LIMITS.tempKeyVerify, env.LOGIN_RATE_LIMITER);
      return jsonError("Invalid temp key", 404);
    }

    // Expired but real: the key existed, so this is a slow user rather than a
    // guesser. Not counted — otherwise someone retrying a stale QR gets blocked.
    if (Date.now() > row.expires_at) {
      await withD1Retry(() => env.DB.prepare(`DELETE FROM temp_keys WHERE temp_key = ?`).bind(normalized).run());
      return jsonError("Temp key expired", 410);
    }

    clearFailures(SCOPE, ip);
    return jsonOk({ apiKey: row.api_key, tempKey: normalized });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
