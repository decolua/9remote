import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS } from "@/features/admin/constants";

export function OPTIONS() { return optionsResponse(); }

export async function DELETE(request, { params }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.sessionDelete);
    if (error) return error;
    const { id } = await params;
    const result = await env.DB.prepare("DELETE FROM sessions WHERE machineId = ?").bind(id).run();
    return jsonOk({ success: true, changes: result?.meta?.changes || 0 });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
