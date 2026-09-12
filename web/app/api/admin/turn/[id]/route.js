import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS } from "@/features/admin/constants";
import { TURN_SCOPES } from "@/features/admin/lib/turnKeys";

export function OPTIONS() { return optionsResponse(); }

export async function PATCH(request, { params }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.turnManage);
    if (error) return error;
    const { id } = await params;
    const { label, scope, enabled } = await request.json();
    if (scope && !TURN_SCOPES.includes(scope)) return jsonError("Invalid scope");
    await env.DB.prepare(`
      UPDATE turnKeys SET
        label = COALESCE(?, label),
        scope = COALESCE(?, scope),
        enabled = COALESCE(?, enabled)
      WHERE id = ?
    `).bind(label ?? null, scope ?? null, enabled === undefined ? null : (enabled ? 1 : 0), id).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

export async function DELETE(request, { params }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.turnManage);
    if (error) return error;
    const { id } = await params;
    await env.DB.prepare("DELETE FROM turnKeys WHERE id = ?").bind(id).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
