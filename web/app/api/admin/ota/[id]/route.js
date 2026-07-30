import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS } from "@/features/admin/constants";
import { parseRow } from "@/features/ota/lib/updateService";

export function OPTIONS() { return optionsResponse(); }

export async function GET(request, { params }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.otaView);
    if (error) return error;

    const row = await env.DB.prepare("SELECT * FROM otaUpdateGroup WHERE id = ?")
      .bind(params.id).first();
    if (!row) return jsonError("Update not found", 404);

    const pointer = await env.DB.prepare(
      "SELECT currentUpdateGroupId FROM otaChannelPointer WHERE channel = ? AND runtimeVersion = ? AND platform = ?"
    ).bind(row.channel, row.runtimeVersion, row.platform).first();

    return jsonOk({
      item: {
        ...parseRow(row),
        isServing: pointer?.currentUpdateGroupId === row.id
      }
    });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

export async function PATCH(request, { params }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.otaManage);
    if (error) return error;

    const { message, status } = await request.json();
    if (message === undefined && !status) return jsonError("Nothing to update");
    if (status && !["active", "archived"].includes(status)) return jsonError("Invalid status");

    const row = await env.DB.prepare("SELECT id FROM otaUpdateGroup WHERE id = ?")
      .bind(params.id).first();
    if (!row) return jsonError("Update not found", 404);

    const sets = [];
    const vals = [];
    if (message !== undefined) { sets.push("message = ?"); vals.push(message); }
    if (status) { sets.push("status = ?"); vals.push(status); }
    vals.push(params.id);
    await env.DB.prepare(`UPDATE otaUpdateGroup SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();

    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
