import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { withD1Retry, readDb } from "@/shared/utils/db";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS, SESSION_SORT_FIELDS, SORT_ORDERS, PAGE_SIZE_DEFAULT } from "@/features/admin/constants";

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.sessionView);
    if (error) return error;

    const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim();
    const sortBy = SESSION_SORT_FIELDS.includes(url.searchParams.get("sortBy"))
      ? url.searchParams.get("sortBy") : "lastAccessAt";
    const order = SORT_ORDERS.includes(url.searchParams.get("order"))
      ? url.searchParams.get("order") : "desc";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.max(1, Math.min(200, parseInt(url.searchParams.get("pageSize") || String(PAGE_SIZE_DEFAULT), 10)));
    const offset = (page - 1) * pageSize;

    const where = search ? "WHERE machineId LIKE ? OR publicIp LIKE ? OR localIp LIKE ?" : "";
    const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

    // Read replica: a browsed list is the one place seconds of lag costs nothing,
    // and this pair is the heaviest scan in the app (COUNT + sorted page).
    const db = readDb(env);
    const totalRow = await withD1Retry(() => db.prepare(`SELECT COUNT(*) AS c FROM sessions ${where}`).bind(...params).first());
    const rows = await withD1Retry(() => db.prepare(`
      SELECT machineId, apiKey, tunnelUrl, publicIp, localIp, createdAt, lastAccessAt, expiresAt
      FROM sessions ${where}
      ORDER BY ${sortBy} ${order.toUpperCase()}
      LIMIT ? OFFSET ?
    `).bind(...params, pageSize, offset).all());

    return jsonOk({ items: rows.results || [], total: totalRow?.c || 0, page, pageSize });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
