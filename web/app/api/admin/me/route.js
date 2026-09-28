import { jsonOk, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  const { error, env, admin } = await requireAdmin(request);
  if (error) return error;
  return jsonOk({
    id: admin.id,
    username: admin.username,
    modeId: admin.modeId,
    modeName: admin.modeName,
    permissions: admin.permissions,
    // OTA admin serves a single operator — hidden unless explicitly enabled.
    otaEnabled: env.OTA_ADMIN_ENABLED === "1"
  });
}
