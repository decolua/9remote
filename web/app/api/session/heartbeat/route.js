import { getCloudflareContext } from "@opennextjs/cloudflare";
import { isAcceptedApiKey } from "@/shared/utils/apiKey";
import { withD1Retry } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { checkMutationAuth } from "@/shared/utils/sessionMutationAuth";

// Agent liveness beat. online=1 every SESSION_HEARTBEAT_INTERVAL_MS while the
// agent runs, online=0 once from the shutdown path. /api/connect reads the
// columns this writes to answer "is the machine up" at login time.

export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const body = await request.json();
    const { apiKey, online } = body;

    if (!apiKey) return jsonError("Missing apiKey");
    if (!(isAcceptedApiKey(apiKey))) return jsonError("Invalid API key");

    // Same ownership proof as /api/session/update — knowing the HEAD is not
    // enough to flip someone's session online/offline.
    const row = await withD1Retry(() => env.DB.prepare(
      "SELECT hostPublicKey FROM sessions WHERE apiKey = ?"
    ).bind(apiKey).first());
    const auth = await checkMutationAuth({ storedPublicKey: row?.hostPublicKey, body });
    if (!auth.ok) return jsonError(`Unauthorized: ${auth.reason}`, 403);

    await withD1Retry(() => env.DB.prepare(
      "UPDATE sessions SET agentOnline = ?, agentSeenAt = datetime('now') WHERE apiKey = ?"
    ).bind(online ? 1 : 0, apiKey).run());

    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
