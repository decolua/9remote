import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc, normalizeApiKey } from "@/shared/utils/apiKey";
import { withD1Retry } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { pickTurnKey, generateIceServers, scopeForOrigin } from "@/features/admin/lib/turnKeys";


export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { env } = getCloudflareContext();
    const apiKey = request.headers.get("X-API-Key");

    if (!apiKey || !(await verifyApiKeyCrc(apiKey, env))) return jsonError("Unauthorized", 401);
    // v2 keys pass the format check alone — a live session row is the real gate
    const session = await withD1Retry(() => env.DB.prepare("SELECT 1 FROM sessions WHERE apiKey = ?").bind(normalizeApiKey(apiKey)).first());
    if (!session) return jsonError("Unauthorized", 401);

    const scope = scopeForOrigin(request.headers.get("Origin"));
    const key = await pickTurnKey(env.DB, scope, env);
    if (!key) return jsonOk({ iceServers: [] });

    // A failing key is not an error the caller can act on — STUN-only connects
    // still work, so hand back an empty list and keep the 502 out of the logs.
    const { iceServers, error } = await generateIceServers(key);
    if (error) console.warn(`[turn-credentials] key ${key.keyId.slice(0, 8)} failed: ${error}`);

    return jsonOk({ iceServers });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
