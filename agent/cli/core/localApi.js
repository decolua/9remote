import os from "os";
import { SERVER_PORT, STEP } from "../../lib/constants.js";
import { renderProgress, updateProgressDesc } from "../utils/tui.js";

let isTuiActive = false;
export function setTuiActive(v) { isTuiActive = v; }

// Probe both families in parallel (Ubuntu/glibc may resolve localhost → ::1 first),
// prefer localhost when both live, cache winner. Reset on failure so we retry next call.
let cachedHost = null;
async function resolveLocalHost() {
  if (cachedHost) return cachedHost;
  const probe = (h) =>
    fetch(`http://${h}:${SERVER_PORT}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => (r.ok ? h : Promise.reject()));
  const results = await Promise.allSettled(["localhost", "127.0.0.1"].map(probe));
  const live = results.map((r, i) => (r.status === "fulfilled" ? ["localhost", "127.0.0.1"][i] : null));
  cachedHost = live.find((h) => h === "localhost") || live.find(Boolean) || null;
  return cachedHost || "127.0.0.1";
}

function bumpHostOnFail() { cachedHost = null; }

export async function apiPost(path, data) {
  const host = await resolveLocalHost();
  try {
    return await fetch(`http://${host}:${SERVER_PORT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch { bumpHostOnFail(); return null; }
}

export async function apiGet(path) {
  const host = await resolveLocalHost();
  try {
    const res = await fetch(`http://${host}:${SERVER_PORT}${path}`);
    return res.ok ? await res.json() : null;
  } catch { bumpHostOnFail(); return null; }
}

export async function pushUiState(data) {
  await apiPost("/api/ui/state", data);
}

export async function setStep(step, extra = {}) {
  if (isTuiActive) renderProgress(step - 1, step > STEP.PREPARING);
  await pushUiState({ step, stepDesc: "", ...extra });
}

export function onBinaryProgress({ phase, percent }) {
  const text = phase === "download"
    ? `Downloading tunnel binary ${percent ?? 0}%`
    : "Extracting tunnel binary";
  if (isTuiActive) updateProgressDesc(text);
  pushUiState({ stepDesc: text });
}

export async function isServerRunning() {
  return !!(await apiGet("/api/health"));
}

export async function fetchServerState() {
  const [d, a, s, si] = await Promise.all([
    apiGet("/api/ui/state"),
    apiGet("/api/device/auto-approve"),
    apiGet("/api/autostart"),
    apiGet("/api/sleep-inhibit"),
  ]);
  return {
    desktopEnabled: !!d?.desktopEnabled,
    remoteAvailable: !!d?.remoteAvailable,
    autoApprove: !!a?.enabled,
    autoStart: !!s?.enabled,
    sleepInhibitMode: si?.mode || "never",
    sleepInhibitActive: !!si?.active,
    sleepInhibitPresets: Array.isArray(si?.presets) ? si.presets : [],
  };
}

export function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}
