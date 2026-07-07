import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import {
  PERMISSIONS,
  SESSION_ONLINE_THRESHOLD_MS,
  SESSION_R3_THRESHOLD_MS,
  SESSION_R7_THRESHOLD_MS,
  SESSION_RETURN_THRESHOLD_MS,
  SESSION_NEW_THRESHOLD_MS,
  SESSION_MAU_THRESHOLD_MS
} from "@/features/admin/constants";

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.sessionView);
    if (error) return error;

    const onlineSec = Math.floor(SESSION_ONLINE_THRESHOLD_MS / 1000);
    const r3Sec = Math.floor(SESSION_R3_THRESHOLD_MS / 1000);
    const r7Sec = Math.floor(SESSION_R7_THRESHOLD_MS / 1000);
    const returnSec = Math.floor(SESSION_RETURN_THRESHOLD_MS / 1000);
    const newSec = Math.floor(SESSION_NEW_THRESHOLD_MS / 1000);
    const mauSec = Math.floor(SESSION_MAU_THRESHOLD_MS / 1000);

    // R3/R7 chỉ tính session có quay lại (lastAccessAt - createdAt > returnSec)
    const row = await env.DB.prepare(`
      WITH s AS (
        SELECT
          createdAt,
          lastAccessAt,
          expiresAt,
          MAX(COALESCE(lastAccessAt, createdAt), createdAt) AS activityAt,
          (lastAccessAt IS NOT NULL AND
           strftime('%s', lastAccessAt) - strftime('%s', createdAt) > ${returnSec}) AS returned
        FROM sessions
      )
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN activityAt >= datetime('now', '-${onlineSec} seconds') THEN 1 ELSE 0 END) AS online,
        SUM(CASE WHEN returned = 1 AND activityAt >= datetime('now', '-${r3Sec} seconds') AND activityAt < datetime('now', '-${onlineSec} seconds') THEN 1 ELSE 0 END) AS r3,
        SUM(CASE WHEN returned = 1 AND activityAt >= datetime('now', '-${r7Sec} seconds') AND activityAt < datetime('now', '-${r3Sec} seconds') THEN 1 ELSE 0 END) AS r7,
        SUM(CASE WHEN expiresAt < datetime('now') THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN createdAt >= datetime('now', '-${newSec} seconds') THEN 1 ELSE 0 END) AS newToday,
        SUM(CASE WHEN returned = 1 AND activityAt >= datetime('now', '-${r7Sec} seconds') THEN 1 ELSE 0 END) AS retained7d,
        SUM(CASE WHEN activityAt >= datetime('now', '-${onlineSec} seconds') THEN 1 ELSE 0 END) AS dau,
        SUM(CASE WHEN activityAt >= datetime('now', '-${mauSec} seconds') THEN 1 ELSE 0 END) AS mau,
        AVG(CASE WHEN lastAccessAt IS NOT NULL
             THEN (strftime('%s', lastAccessAt) - strftime('%s', createdAt)) / 86400.0 END) AS avgLifespan
      FROM s
    `).first();

    const total = row?.total || 0;
    const online = row?.online || 0;
    const r3 = row?.r3 || 0;
    const r7 = row?.r7 || 0;
    const expired = row?.expired || 0;
    const offline = Math.max(0, total - online - r3 - r7 - expired);
    // Effectiveness metrics
    const newToday = row?.newToday || 0;
    const retention7d = total > 0 ? Math.round(((row?.retained7d || 0) / total) * 100) : 0;
    const stickiness = row?.mau > 0 ? Math.round((row.dau / row.mau) * 100) : 0;
    const avgLifespanDays = row?.avgLifespan ? Math.round(row.avgLifespan * 10) / 10 : 0;
    return jsonOk({ total, online, r3, r7, offline, expired, newToday, retention7d, stickiness, avgLifespanDays });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
