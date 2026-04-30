import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS, PERMISSION_LIST } from "@/features/admin/constants";

export function OPTIONS() { return optionsResponse(); }

export async function PATCH(request, { params }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.modeManage);
    if (error) return error;
    const { id } = await params;
    const { name, permissions } = await request.json();
    const filtered = Array.isArray(permissions) ? permissions.filter((p) => PERMISSION_LIST.includes(p)) : null;
    await env.DB.prepare(`
      UPDATE modes SET
        name = COALESCE(?, name),
        permissions = COALESCE(?, permissions)
      WHERE id = ?
    `).bind(name ?? null, filtered ? JSON.stringify(filtered) : null, id).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

export async function DELETE(request, { params }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.modeManage);
    if (error) return error;
    const { id } = await params;
    const used = await env.DB.prepare("SELECT COUNT(*) AS c FROM admins WHERE modeId = ?").bind(id).first();
    if ((used?.c || 0) > 0) return jsonError("Mode is in use by admins", 400);
    await env.DB.prepare("DELETE FROM modes WHERE id = ?").bind(id).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
