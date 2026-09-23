import { getCloudflareContext } from "@opennextjs/cloudflare";
import { withD1Retry } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";

// Batched host liveness for the fleet tree: one request answers "is each machine
// up" for every saved key, read from the agent heartbeat columns /api/connect
// already trusts. "Online" here means "recently beat" — the live bus confirms
// the moment a host is actually opened.

const OFFLINE_GRACE_SEC = 300;
const MAX_HEADS = 16;

export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const { heads } = await request.json();
    if (!Array.isArray(heads)) return jsonError("Missing heads");
    // Heads are identifiers, not secrets — same trust level /api/connect uses.
    const clean = [...new Set(heads.filter((h) => typeof h === "string" && h.length <= 64))].slice(0, MAX_HEADS);
    if (!clean.length) return jsonError("Missing heads");

    const placeholders = clean.map(() => "?").join(",");
    const rows = await withD1Retry(() => env.DB.prepare(
      `SELECT apiKey, agentOnline, agentSeenAt FROM sessions WHERE apiKey IN (${placeholders})`
    ).bind(...clean).all());

    const hosts = {};
    for (const r of rows?.results || []) {
      const seen = r.agentSeenAt ? new Date(`${String(r.agentSeenAt).replace(" ", "T")}Z`).getTime() : NaN;
      const stale = !Number.isNaN(seen) && seen < Date.now() - OFFLINE_GRACE_SEC * 1000;
      hosts[r.apiKey] = { online: !(r.agentOnline === 0 || stale), seenAt: r.agentSeenAt || null };
    }
    return jsonOk({ hosts });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
