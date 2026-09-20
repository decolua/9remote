import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { withD1Retry } from "@/shared/utils/db";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS } from "@/features/admin/constants";

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.logView);
    if (error) return error;

    const rows = await withD1Retry(() => env.DB.prepare(
      "SELECT username, ip, ok, reason, createdAt FROM adminLoginLog ORDER BY createdAt DESC LIMIT 50"
    ).all());
    return jsonOk({ items: rows.results || [] });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
