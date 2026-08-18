// Kimi Code quota: access token from ~/.kimi/credentials/kimi-code.json, then
// GET /usages. Top-level `usage` = weekly quota; `limits[]` carries shorter
// rolling windows — the 5h one is the session view.
import { join } from "node:path";
import { homedir } from "node:os";
import { API_TIMEOUT_MS, KIMI_BASE_URL, SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES } from "../constants.js";
import { clampPercent, fetchJson, makeResult, parseResetTimestamp, readJsonFile } from "../lib/quotaWindow.js";

const credentialsPath = () => join(process.env.KIMI_HOME || join(homedir(), ".kimi"), "credentials", "kimi-code.json");

const toInt = (v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function windowToMinutes(window) {
  const duration = toInt(window?.duration);
  if (duration === null) return null;
  const unit = (window?.timeUnit ?? "").toUpperCase();
  if (unit.includes("MINUTE")) return duration;
  if (unit.includes("HOUR")) return duration * 60;
  if (unit.includes("DAY")) return duration * 60 * 24;
  if (unit.includes("SECOND")) return Math.round(duration / 60);
  return duration;
}

function mapWindow(detail, windowMinutes) {
  if (!detail) return null;
  const limit = toInt(detail.limit);
  let used = toInt(detail.used);
  if (used === null) {
    const remaining = toInt(detail.remaining);
    if (remaining !== null && limit !== null) used = limit - remaining;
  }
  if (limit === null || limit <= 0 || used === null) return null;
  const reset = detail.resetTime ?? detail.resetAt;
  return {
    usedPercent: clampPercent((used / limit) * 100),
    windowMinutes,
    resetsAt: reset ? parseResetTimestamp(reset) : null
  };
}

export async function fetchKimiQuota() {
  const creds = await readJsonFile(credentialsPath());
  if (!creds?.access_token && !creds?.refresh_token) {
    return makeResult("kimi", "unavailable", "Not signed in to Kimi Code");
  }
  // expires_at is Unix seconds; skip fetch when expired — the CLI refreshes the file on its next run.
  const fresh = creds.access_token
    && typeof creds.expires_at === "number"
    && creds.expires_at - Math.floor(Date.now() / 1000) > 5;
  if (!fresh) return makeResult("kimi", "unavailable", "Kimi session expired — run kimi to refresh");

  try {
    const data = await fetchJson(`${KIMI_BASE_URL}/usages`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
      timeoutMs: API_TIMEOUT_MS
    });
    const weekly = mapWindow(data?.usage, WEEKLY_WINDOW_MINUTES);
    let session = null;
    for (const limit of data?.limits ?? []) {
      const minutes = windowToMinutes(limit.window) ?? SESSION_WINDOW_MINUTES;
      const mapped = mapWindow(limit.detail, minutes);
      // Prefer the window closest to a 5h session; otherwise keep the first seen.
      if (mapped && (session === null
        || Math.abs(minutes - SESSION_WINDOW_MINUTES) < Math.abs(session.windowMinutes - SESSION_WINDOW_MINUTES))) {
        session = mapped;
      }
    }
    if (!session && !weekly) return makeResult("kimi", "error", "Kimi usage response did not include quota windows");
    return makeResult("kimi", "ok", null, { session, weekly });
  } catch (e) {
    return makeResult("kimi", "error", e.message);
  }
}
