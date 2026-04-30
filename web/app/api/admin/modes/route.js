import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS, PERMISSION_LIST } from "@/features/admin/constants";

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.modeView);
    if (error) return error;
    const rows = await env.DB.prepare("SELECT id, name, permissions, createdAt FROM modes ORDER BY createdAt ASC").all();
    return jsonOk({ items: rows.results || [] });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

export async function POST(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.modeManage);
    if (error) return error;
    const { id, name, permissions } = await request.json();
    if (!id || !name) return jsonError("Missing id or name");
    const filtered = (permissions || []).filter((p) => PERMISSION_LIST.includes(p));
    await env.DB.prepare("INSERT INTO modes (id, name, permissions) VALUES (?, ?, ?)")
      .bind(id, name, JSON.stringify(filtered)).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
