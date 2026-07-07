import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";

export function OPTIONS() { return optionsResponse(); }

// GET ?accountId= → {plan, status, expiresAt}
export async function GET(request) {
  try {
    const { env } = getCloudflareContext();
    const url = new URL(request.url);
    const accountId = url.searchParams.get("accountId");
    if (!accountId) return jsonError("Missing accountId");

    const ent = await env.DB.prepare(
      "SELECT plan, status, expiresAt FROM iap_entitlements WHERE accountId = ?"
    ).bind(accountId).first();
    if (!ent) return jsonOk({ plan: null, status: "inactive", expiresAt: null });

    // Expired check (best-effort; webhook updates status async in full impl)
    const expired = ent.expiresAt && new Date(ent.expiresAt) < new Date();
    return jsonOk({
      plan: ent.plan,
      status: expired ? "expired" : ent.status,
      expiresAt: ent.expiresAt
    });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
