import { jsonOk, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  const { error, admin } = await requireAdmin(request);
  if (error) return error;
  return jsonOk({
    id: admin.id,
    username: admin.username,
    modeId: admin.modeId,
    modeName: admin.modeName,
    permissions: admin.permissions
  });
}
