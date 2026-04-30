import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS } from "@/features/admin/constants";
import { hashPassword } from "@/features/admin/lib/auth";

export function OPTIONS() { return optionsResponse(); }

export async function PATCH(request, { params }) {
  try {
    const { error, env, admin } = await requireAdmin(request, PERMISSIONS.adminManage);
    if (error) return error;
    const { id } = await params;
    const { password, modeId } = await request.json();
    const hash = password ? await hashPassword(password) : null;
    await env.DB.prepare(`
      UPDATE admins SET
        passwordHash = COALESCE(?, passwordHash),
        modeId = COALESCE(?, modeId)
      WHERE id = ?
    `).bind(hash, modeId ?? null, id).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

export async function DELETE(request, { params }) {
  try {
    const { error, env, admin } = await requireAdmin(request, PERMISSIONS.adminManage);
    if (error) return error;
    const { id } = await params;
    if (id === admin.id) return jsonError("Cannot delete yourself", 400);
    await env.DB.prepare("DELETE FROM admins WHERE id = ?").bind(id).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
