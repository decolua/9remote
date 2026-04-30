import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonError } from "@/shared/utils/apiResponse";
import { readTokenFromRequest, verifyAdminToken } from "./auth";
import { hasPermission, parsePermissions } from "./permissions";

export async function requireAdmin(request, requiredPermission) {
  const { env } = getCloudflareContext();
  const token = readTokenFromRequest(request);
  if (!token) return { error: jsonError("Unauthorized", 401) };

  const payload = await verifyAdminToken(env, token);
  if (!payload?.adminId) return { error: jsonError("Unauthorized", 401) };

  const row = await env.DB.prepare(`
    SELECT a.id, a.username, a.modeId, m.name AS modeName, m.permissions
    FROM admins a JOIN modes m ON a.modeId = m.id
    WHERE a.id = ?
  `).bind(payload.adminId).first();

  if (!row) return { error: jsonError("Unauthorized", 401) };

  const perms = parsePermissions(row.permissions);
  if (requiredPermission && !hasPermission(perms, requiredPermission)) {
    return { error: jsonError("Forbidden", 403) };
  }

  return { env, admin: { ...row, permissions: perms } };
}
