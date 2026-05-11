import os from "os";
import { SERVER_PORT, STEP } from "../../lib/constants.js";
import { renderProgress, updateProgressDesc } from "../utils/tui.js";

let isTuiActive = false;
export function setTuiActive(v) { isTuiActive = v; }

export async function apiPost(path, data) {
  try {
    return await fetch(`http://localhost:${SERVER_PORT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch { return null; }
}

export async function apiGet(path) {
  try {
    const res = await fetch(`http://localhost:${SERVER_PORT}${path}`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
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
