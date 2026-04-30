import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS } from "@/features/admin/constants";
import { hashPassword } from "@/features/admin/lib/auth";

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.adminView);
    if (error) return error;
    const rows = await env.DB.prepare(`
      SELECT a.id, a.username, a.modeId, a.createdAt, a.lastLoginAt, m.name AS modeName
      FROM admins a LEFT JOIN modes m ON a.modeId = m.id
      ORDER BY a.createdAt ASC
    `).all();
    return jsonOk({ items: rows.results || [] });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

export async function POST(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.adminManage);
    if (error) return error;
    const { username, password, modeId } = await request.json();
    if (!username || !password || !modeId) return jsonError("Missing fields");
    const id = `admin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const hash = await hashPassword(password);
    await env.DB.prepare("INSERT INTO admins (id, username, passwordHash, modeId) VALUES (?, ?, ?, ?)")
      .bind(id, username, hash, modeId).run();
    return jsonOk({ success: true, id });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
