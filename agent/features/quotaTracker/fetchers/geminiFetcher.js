// Gemini CLI quota: OAuth creds from ~/.gemini/oauth_creds.json, refreshed via
// Google's token endpoint when expired, then POST retrieveUserQuota for
// per-model buckets (remainingFraction → usedPercent).
import { exec } from "node:child_process";
import { readFile, realpath, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  API_TIMEOUT_MS,
  GEMINI_LOAD_PROJECT_URL,
  GEMINI_MODEL_NAMES,
  GEMINI_QUOTA_URL,
  GEMINI_TOKEN_URL
} from "../constants.js";
import { clampPercent, fetchJson, makeResult, readJsonFile } from "../lib/quotaWindow.js";

const execAsync = promisify(exec);
const CREDS_PATH = () => join(process.env.GEMINI_CLI_HOME || join(homedir(), ".gemini"), "oauth_creds.json");

function humanizeModelId(modelId) {
  return modelId.replace(/^gemini-/i, "").split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function mapBucket(b) {
  if (typeof b?.remainingFraction !== "number" || !Number.isFinite(b.remainingFraction)) return null;
  return {
    name: GEMINI_MODEL_NAMES[b.modelId] ?? humanizeModelId(b.modelId || "gemini"),
    usedPercent: clampPercent(Math.round((1 - b.remainingFraction) * 100)),
    windowMinutes: 60,
    resetsAt: b.resetTime ? new Date(b.resetTime).getTime() || null : null
  };
}

// Same usedPercent+resetsAt buckets arrive per alias model — keep the shortest name.
function dedupeBuckets(buckets) {
  const byKey = new Map();
  for (const b of buckets) {
    const key = `${b.usedPercent}-${b.resetsAt}`;
    const existing = byKey.get(key);
    if (!existing || b.name.length < existing.name.length) byKey.set(key, b);
  }
  return [...byKey.values()];
}

async function fileExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

// OAuth client creds live inside the installed gemini-cli bundle (oauth2.js) —
// reuse them for refresh instead of embedding secrets here.
async function extractClientCredentials() {
  let bin = null;
  try {
    const which = process.platform === "win32" ? "where gemini" : "which gemini";
    const { stdout } = await execAsync(which);
    bin = stdout.trim().split(/\r?\n/)[0] || null;
  } catch { /* not on PATH */ }
  if (!bin && process.platform !== "win32") {
    for (const candidate of ["/usr/local/bin/gemini", "/opt/homebrew/bin/gemini", join(homedir(), ".local/bin/gemini")]) {
      if (await fileExists(candidate)) { bin = candidate; break; }
    }
  }
  if (!bin) return null;

  const real = await realpath(bin).catch(() => bin);
  const baseDir = dirname(dirname(real));
  // Official layout is code_assist; keep code_assistant as an alias-tolerant fallback.
  const subpaths = [
    join("dist", "src", "code_assist", "oauth2.js"),
    join("dist", "src", "code_assistant", "oauth2.js")
  ];
  const candidates = [];
  for (const subpath of subpaths) {
    candidates.push(
      join(baseDir, "libexec", "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", subpath),
      join(baseDir, "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", subpath),
      join(baseDir, "share", "gemini-cli", "node_modules", "@google", "gemini-cli-core", subpath),
      join(baseDir, "..", "gemini-cli-core", subpath),
      join(baseDir, "node_modules", "@google", "gemini-cli-core", subpath)
    );
  }
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf-8");
      const clientId = content.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)?.[1];
      const clientSecret = content.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)?.[1];
      if (clientId && clientSecret) return { clientId, clientSecret };
    } catch { /* try next layout */ }
  }
  return null;
}

async function refreshAccessToken(refreshToken) {
  const creds = await extractClientCredentials();
  if (!creds) return { error: "gemini CLI not found — cannot refresh token" };
  const res = await fetch(GEMINI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...creds, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Revoked/expired refresh token — only a fresh `gemini` login fixes it.
    return { error: data.error === "invalid_grant"
      ? "Gemini sign-in expired — run gemini to re-login"
      : `Gemini token refresh failed (HTTP ${res.status})` };
  }
  return { token: data.access_token || null };
}

async function loadProjectId(accessToken) {
  const data = await fetchJson(GEMINI_LOAD_PROJECT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    timeoutMs: API_TIMEOUT_MS
  });
  return data?.project || null;
}

export async function fetchGeminiQuota() {
  const creds = await readJsonFile(CREDS_PATH());
  if (!creds?.access_token && !creds?.refresh_token) {
    return makeResult("gemini", "unavailable", "Not signed in to Gemini CLI");
  }

  try {
    let accessToken = creds.access_token;
    if (!accessToken || typeof creds.expiry_date !== "number" || creds.expiry_date <= Date.now()) {
      const refreshed = await refreshAccessToken(creds.refresh_token);
      if (refreshed.error) return makeResult("gemini", "error", refreshed.error);
      accessToken = refreshed.token;
      if (!accessToken) return makeResult("gemini", "error", "Gemini token refresh failed");
    }
    const projectId = await loadProjectId(accessToken);
    if (!projectId) return makeResult("gemini", "error", "Gemini project ID not found");

    const data = await fetchJson(GEMINI_QUOTA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ project: projectId }),
      timeoutMs: API_TIMEOUT_MS
    });
    const rawBuckets = (Array.isArray(data) ? data : data?.buckets ?? [])
      .map(mapBucket).filter(Boolean);
    if (!rawBuckets.length) return makeResult("gemini", "ok");

    const buckets = dedupeBuckets(rawBuckets);
    // Summary = most-constrained bucket.
    const worst = buckets.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    return makeResult("gemini", "ok", null, {
      session: { usedPercent: worst.usedPercent, windowMinutes: 60, resetsAt: worst.resetsAt },
      buckets
    });
  } catch (e) {
    return makeResult("gemini", "error", e.message);
  }
}
