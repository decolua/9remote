import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS } from "@/features/admin/constants";
import { parseRow } from "@/features/ota/lib/updateService";

const PAGE_SIZE = 20;

export function OPTIONS() { return optionsResponse(); }

// List update groups with optional filters + pagination.
export async function GET(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.otaView);
    if (error) return error;

    const url = new URL(request.url);
    const runtimeVersion = url.searchParams.get("runtimeVersion") || "";
    const platform = url.searchParams.get("platform") || "";
    const channel = url.searchParams.get("channel") || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

    let sql = "SELECT * FROM otaUpdateGroup";
    const conds = [];
    const vals = [];
    if (runtimeVersion) { conds.push("runtimeVersion = ?"); vals.push(runtimeVersion); }
    if (platform) { conds.push("platform = ?"); vals.push(platform); }
    if (channel) { conds.push("channel = ?"); vals.push(channel); }
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY buildNumber DESC LIMIT ? OFFSET ?";
    vals.push(PAGE_SIZE, (page - 1) * PAGE_SIZE);

    const { results } = await env.DB.prepare(sql).bind(...vals).all();

    // Mark which builds are currently serving
    const pointers = await env.DB.prepare("SELECT * FROM otaChannelPointer").all();
    const servingIds = new Set((pointers.results || []).map((p) => p.currentUpdateGroupId).filter(Boolean));
    const items = (results || []).map((r) => ({ ...parseRow(r), isServing: servingIds.has(r.id) }));

    return jsonOk({ items, page });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
