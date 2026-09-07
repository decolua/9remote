import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cleanupDeadTunnels } from "@/shared/utils/tunnelService";
import { jsonOk, jsonError } from "@/shared/utils/apiResponse";
import { timingSafeEqualStr } from "@/shared/utils/crypto";


export async function GET(request) {
  try {
    const { env } = getCloudflareContext();
    const secret = env.CRON_SECRET || env.APP_SECRET;
    if (!secret) return jsonError("CRON_SECRET or APP_SECRET not configured", 500);
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!timingSafeEqualStr(token, secret)) return jsonError("Unauthorized", 401);

    const tempKeysResult = await env.DB.prepare(`DELETE FROM temp_keys WHERE expires_at < ?`).bind(Date.now()).run();
    const tunnelsCleaned = await cleanupDeadTunnels(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_KEY, env.CLOUDFLARE_EMAIL);

    return jsonOk({ tempKeys: tempKeysResult.meta.changes, tunnels: tunnelsCleaned });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
