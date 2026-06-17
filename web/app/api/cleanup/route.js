import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cleanupDeadTunnels } from "@/shared/utils/tunnelService";
import { jsonOk, jsonError } from "@/shared/utils/apiResponse";
import { timingSafeEqualStr } from "@/shared/utils/crypto";


export async function GET(request) {
  try {
    const { env } = getCloudflareContext();
    if (!env.CRON_SECRET) return jsonError("CRON_SECRET not configured", 500);
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!timingSafeEqualStr(token, env.CRON_SECRET)) return jsonError("Unauthorized", 401);

    const sessionsResult = await env.DB.prepare(`DELETE FROM sessions WHERE expiresAt < datetime('now')`).run();
    const tempKeysResult = await env.DB.prepare(`DELETE FROM temp_keys WHERE expires_at < ?`).bind(Date.now()).run();
    const tunnelsCleaned = await cleanupDeadTunnels(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_KEY, env.CLOUDFLARE_EMAIL);

    return jsonOk({ sessions: sessionsResult.meta.changes, tempKeys: tempKeysResult.meta.changes, tunnels: tunnelsCleaned });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
