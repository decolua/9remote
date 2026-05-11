/**
 * UI state & SSE event handlers (localhost-only)
 */

import { STEP, PERMISSION_POLL_FAST_MS, PERMISSION_POLL_FAST_DURATION } from "../lib/constants.js";
import { setSseEmitter, readRecentLogs } from "../lib/logger.js";
import { LOG_TAIL_LINES } from "../lib/constants.js";
import { writeCmd } from "../cli/utils/state.js";
import { checkPermissions, openPermissionPane } from "../cli/utils/permissions.js";
import { isAutoStartEnabled, setAutoStart } from "../cli/utils/autostart.js";
import { jsonOk } from "../lib/router.js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { PATHS } from "../lib/constants.js";
import { readSettings, writeSettings } from "../lib/settings.js";

const UI_STATE_FILE = join(PATHS.STATE, "ui-state.json");

function ensureDir() {
  mkdirSync(PATHS.STATE, { recursive: true });
}

// ── State ────────────────────────────────────────────────────────────────────

let uiState = {
  step: STEP.STOPPED,
  stepDesc: "",
  tunnelUrl: "",
  oneTimeKey: "",
  oneTimeKeyExpiresAt: null,
  permanentKey: "",
  qrUrl: "",
  latency: null,
  uptime: null,
  // Health check telemetry for the Verifying step (shown as a mini terminal in UI)
  healthCheck: {
    running: false,
    timeoutMs: 0,
    startedAt: null,
    logs: [], // [{ attempt, status, elapsedMs, ok, time }]
  },
  // Ongoing tunnel health status (polled every N seconds after READY)
  tunnelHealth: { status: "unknown", checkedAt: null },
};

let desktopEnabled = false;
let remoteAvailable = false;
let cachedPermissions = { screenRecording: false, accessibility: false };
const sseClients = new Set();
const activeConnections = new Map();

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadUiState() {
  try {
    if (existsSync(UI_STATE_FILE)) {
      const saved = JSON.parse(readFileSync(UI_STATE_FILE, "utf8"));
      if (saved.step === STEP.READY && saved.permanentKey) {
        uiState = { ...uiState, ...saved };
      }
    }
  } catch { }
}

function saveUiState() {
  try {
    ensureDir();
    writeFileSync(UI_STATE_FILE, JSON.stringify(uiState));
  } catch { }
}

export function loadDesktopState() {
  desktopEnabled = !!readSettings().desktopEnabled;
}

function saveDesktopState() {
  writeSettings({ desktopEnabled });
}

// ── SSE / Events ─────────────────────────────────────────────────────────────

export function pushUiEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

export function pushUiLog(message) {
  pushUiEvent("log", { message: `[${new Date().toLocaleTimeString()}] ${message}` });
}

// Bridge logger → SSE so every console/crash message reaches TUI + Web UI
setSseEmitter(pushUiLog);

// ── Getters / Setters (used by other modules) ────────────────────────────────

export function getUiState() { return uiState; }

export function updateUiState(data) {
  uiState = { ...uiState, ...data };
  pushUiEvent("state", uiState);
  saveUiState();
}

export function clearOneTimeKey() {
  updateUiState({ oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "" });
}

export function getDesktopEnabled() { return desktopEnabled; }

export function setRemoteAvailable(value) { remoteAvailable = !!value; }
export function getRemoteAvailable() { return remoteAvailable; }

export function getPermissions() { return cachedPermissions; }

// Remote desktop fully usable only when capable + toggled ON + both permissions granted
export function isRemoteReady() {
  return !!remoteAvailable
    && !!desktopEnabled
    && !!cachedPermissions.screenRecording
    && !!cachedPermissions.accessibility;
}

// Broadcast hook — registered by socket layer to notify clients on state change
let onRemoteReadyChange = null;
export function setRemoteReadyChangeHandler(fn) { onRemoteReadyChange = fn; }

export async function refreshPermissionsAsync() {
  const p = await checkPermissions();
  const prev = cachedPermissions;
  const prevReady = isRemoteReady();
  cachedPermissions = p;
  // Auto-disable desktop when a required permission was revoked
  if (desktopEnabled && (!p.screenRecording || !p.accessibility)) {
    desktopEnabled = false;
    saveDesktopState();
  }
  // Auto-enable desktop when both permissions transition to granted
  const bothBefore = prev.screenRecording && prev.accessibility;
  const bothNow = p.screenRecording && p.accessibility;
  if (!desktopEnabled && !bothBefore && bothNow) {
    desktopEnabled = true;
    saveDesktopState();
  }
  const changed = prev.screenRecording !== p.screenRecording || prev.accessibility !== p.accessibility;
  if (changed) pushUiEvent("permissions", { ...cachedPermissions, desktopEnabled });
  if (isRemoteReady() !== prevReady) onRemoteReadyChange?.();
  return p;
}

export function trackConnection(socketId, ip, deviceId = null, type = "ws") {
  activeConnections.set(socketId, { socketId, ip, deviceId, type, connectedAt: Date.now() });
  pushUiEvent("connections", { connections: [...activeConnections.values()] });
  notifyConnectionChange();
}

export function untrackConnection(socketId) {
  activeConnections.delete(socketId);
  pushUiEvent("connections", { connections: [...activeConnections.values()] });
  notifyConnectionChange();
}

async function notifyConnectionChange() {
  try {
    const m = await import("../lib/sleepInhibitor.js");
    m.onConnectionChange(activeConnections.size);
  } catch {}
}

// ── Route Handlers ───────────────────────────────────────────────────────────

export function handleSseEvents(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.writeHead(200);

  res.write(`data: ${JSON.stringify({ type: "state", ...uiState })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: "connections", connections: [...activeConnections.values()] })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: "permissions", ...cachedPermissions, desktopEnabled })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

export function handleStateGet(req, res) {
  jsonOk(res, { ...uiState, ...cachedPermissions, desktopEnabled, remoteAvailable });
}

export async function handleStatePost(req, res) {
  const { parseJsonBody } = await import("../lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  updateUiState(data);
  jsonOk(res);
}

export function handleStop(req, res) {
  jsonOk(res);
  updateUiState({ step: STEP.STOPPED, stepDesc: "", tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null });
  writeCmd("stop-tunnel");
}

export function handleStart(req, res) {
  jsonOk(res);
  updateUiState({ step: STEP.PREPARING, stepDesc: "" });
  writeCmd("start-tunnel");
}

export function handleShutdown(req, res) {
  jsonOk(res);
  updateUiState({ step: STEP.STOPPED, stepDesc: "", tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null });
  writeCmd("shutdown");
}

export function handleConnections(req, res) {
  jsonOk(res, { connections: [...activeConnections.values()] });
}

export function handleLogsGet(req, res) {
  const url = new URL(req.url, "http://localhost");
  const n = parseInt(url.searchParams.get("lines") || LOG_TAIL_LINES, 10);
  jsonOk(res, { logs: readRecentLogs(Number.isFinite(n) ? n : LOG_TAIL_LINES) });
}

export async function handleDesktopToggle(req, res) {
  const { parseJsonBody } = await import("../lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const next = !!data.enabled;
  // Block enabling when required permissions are not granted
  if (next && (!cachedPermissions.screenRecording || !cachedPermissions.accessibility)) {
    jsonOk(res, { ok: false, enabled: desktopEnabled, reason: "permissions_required" });
    return;
  }
  const prevReady = isRemoteReady();
  desktopEnabled = next;
  saveDesktopState();
  pushUiEvent("permissions", { ...cachedPermissions, desktopEnabled });
  if (isRemoteReady() !== prevReady) onRemoteReadyChange?.();
  jsonOk(res, { ok: true, enabled: desktopEnabled });
}

export function handlePermissionsGet(req, res) {
  jsonOk(res, cachedPermissions);
}

export async function handleAutoStartGet(req, res) {
  const enabled = await isAutoStartEnabled();
  jsonOk(res, { enabled });
}

export async function handleAutoStartPost(req, res) {
  const { parseJsonBody } = await import("../lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const ok = await setAutoStart(!!data.enabled);
  const enabled = await isAutoStartEnabled();
  pushUiEvent("autostart", { enabled });
  jsonOk(res, { ok, enabled });
}

export async function handlePermissionsRequest(req, res) {
  const { parseJsonBody } = await import("../lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const { type } = data;
  if (process.platform === "darwin") {
    openPermissionPane(type);
    // Fast-poll while user is in System Settings — reuses refreshPermissionsAsync to stay DRY
    const started = Date.now();
    const poll = setInterval(async () => {
      const p = await refreshPermissionsAsync();
      if (p[type] || Date.now() - started > PERMISSION_POLL_FAST_DURATION) clearInterval(poll);
    }, PERMISSION_POLL_FAST_MS);
  }
  jsonOk(res);
}
