// Shared shape helpers for quota windows. A window is
// { usedPercent, windowMinutes, resetsAt } — resetsAt in Unix ms, null if unknown.
import { readFile } from "node:fs/promises";

export function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

// 1e10 separates any seconds epoch (<2286) from any ms epoch (>2001).
export function parseResetTimestamp(value) {
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(num) && String(value).trim() !== "") {
    return num > 10_000_000_000 ? num : num * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function makeResult(provider, status, error = null, windows = {}) {
  return {
    provider,
    session: windows.session ?? null,
    weekly: windows.weekly ?? null,
    monthly: windows.monthly ?? null,
    buckets: windows.buckets ?? null,
    updatedAt: Date.now(),
    error,
    status
  };
}

export async function fetchJson(url, options = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000), ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Read + JSON.parse a credential file; null when missing (ENOENT) — caller decides
// whether that means "signed out" vs "error".
export async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}
