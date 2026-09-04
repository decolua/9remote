/**
 * UI state & SSE event handlers (localhost-only)
 */

import { STEP, PERMISSION_POLL_FAST_MS, PERMISSION_POLL_FAST_DURATION, SERVER_PORT } from "../lib/constants.js";
import { setSseEmitter, readRecentLogs, clearRecentLogs, createLogger, IS_DEBUG } from "../lib/logger.js";
import { LOG_TAIL_LINES } from "../lib/constants.js";
import { writeCmd } from "../cli/utils/state.js";
import { checkPermissions, openPermissionPane } from "../cli/utils/permissions.js";
import { isAutoStartEnabled, setAutoStart } from "../cli/utils/autostart.js";
import { jsonOk, jsonErr } from "../lib/router.js";
import { getLocalToken } from "../lib/localToken.js";
import { LOCAL_UI_ORIGINS } from "../lib/constants.js";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { writeJsonAtomic } from "../lib/atomicFile.js";
import { join } from "path";
import { PATHS } from "../lib/constants.js";
import { readSettings, writeSettings } from "../lib/settings.js";
import { getSignalingState } from "../lib/signalingGlobal.js";
import { getTransportStats, broadcast } from "../transport/broadcast.js";
import { isRtcTestDisabled, setRtcTestDisabled } from "../transport/server.js";
import { WORKER_URL } from "../cli/config.js";
import os from "os";

function getLocalIp() {
  try {
    for (const iface of Object.values(os.networkInterfaces())) {
      for (const addr of iface || []) {
        if (addr.family === "IPv4" && !addr.internal) return addr.address;
      }
    }
  } catch {}
  return null;
}

const UI_STATE_FILE = join(PATHS.STATE, "ui-state.json");
const logger = createLogger("ui");

function ensureDir() {
  mkdirSync(PATHS.STATE, { recursive: true });
}

// ── State ────────────────────────────────────────────────────────────────────

let uiState = {
  step: STEP.STOPPED,
  stepDesc: "",
  workerUrl: WORKER_URL,
  tunnelUrl: "",
  oneTimeKey: "",
  oneTimeKeyExpiresAt: null,
  // A pairing code was minted and consumed at least once — the UI must not
  // silently mint another one (each code opens a fresh pairing window).
  pairingUsed: false,
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
        // pairingUsed is per-run: it only exists to stop the UI auto-minting a
        // replacement code right after one was consumed (or the key replaced).
        // Persisting it would silence the QR on every later start too.
        uiState = { ...uiState, ...saved, pairingUsed: false };
      }
    }
  } catch { }
}

function saveUiState() {
  try {
    ensureDir();
    writeJsonAtomic(UI_STATE_FILE, uiState, { spaces: 0 });
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
  pushUiEvent("log", { message: `[${new Date().toLocaleTimeString(undefined, { hour12: false })}] ${message}` });
}

// Dev-only UI log — per-socket noise stays out of prod (AGENT_DEBUG=1 to see it)
export function pushUiLogDebug(message) {
  if (IS_DEBUG) pushUiLog(message);
}

// Bridge logger → SSE. Forward the formatted line as-is — it already carries a 24h
// timestamp from logger.js (shortTs), so wrapping via pushUiLog would double-stamp.
setSseEmitter((line) => pushUiEvent("log", { message: line }));

// ── Getters / Setters (used by other modules) ────────────────────────────────

export function getUiState() { return uiState; }

export function getTunnelPayload() {
  const isReady = uiState.step === STEP.READY && !!uiState.tunnelUrl;
  const lanIp = getLocalIp();
  return {
    status: isReady ? "ready" : "down",
    tunnelUrl: isReady ? uiState.tunnelUrl : null,
    localIp: lanIp ? `${lanIp}:${SERVER_PORT}` : null
  };
}

export function updateUiState(data) {
  const prevTunnel = uiState.tunnelUrl;
  const prevStep = uiState.step;
  uiState = { ...uiState, ...data };
  pushUiEvent("state", uiState);
  saveUiState();

  // Broadcast tunnel URL update to connected RTC/WS clients
  if (data.tunnelUrl !== undefined || data.step !== undefined) {
    const tunnelChanged = data.tunnelUrl !== undefined && data.tunnelUrl !== prevTunnel;
    const stepChanged = data.step !== undefined && data.step !== prevStep;
    if (tunnelChanged || (stepChanged && (uiState.step === STEP.READY || uiState.step === STEP.STOPPED))) {
      broadcast(null, "tunnel:updated", getTunnelPayload());
    }
  }
}

export function clearOneTimeKey() {
  // Intentionally does NOT clear the pairing window (lib/pairingCode.js):
  // enrollment happens after the tempKey is consumed, so the window must
  // outlive the code display — its own 10-minute TTL bounds it.
  // pairingUsed stops the UI from auto-minting a replacement code.
  updateUiState({ oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "", pairingUsed: true });
}

// Latest available update { version } or null — set by periodic check, read by serverInfo
let updateInfo = null;
export function getUpdateInfo() { return updateInfo; }
export function setUpdateInfo(info) { updateInfo = info || null; }

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

/**
 * Issue the ephemeral local token to the trusted localhost UI only.
 * Origin guard blocks malicious cross-origin pages (router already enforces loopback).
 */
export function handleLocalToken(req, res) {
  const origin = req.headers.origin;
  // Browser cross-origin requests always send Origin; allow only same-origin UI or non-browser (no Origin)
  if (origin && !LOCAL_UI_ORIGINS.includes(origin)) {
    return jsonErr(res, 403, "Forbidden origin");
  }
  jsonOk(res, { localToken: getLocalToken() });
}

// ── Transport status (DO signaling / RTC / tunnel WS) ────────────────────────

export function getTransportState() {
  const { started, ready } = getSignalingState();
  return { signaling: ready ? "connected" : started ? "connecting" : "off", rtcDisabled: isRtcTestDisabled(), ...getTransportStats() };
}

export async function handleRtcToggle(req, res) {
  const { parseJsonBody } = await import("../lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  setRtcTestDisabled(!!data.disabled);
  pushTransportState();
  jsonOk(res, { rtcDisabled: isRtcTestDisabled() });
}

export function pushTransportState() {
  pushUiEvent("transport", getTransportState());
}

/** How many clients are connected right now. */
export function connectionCount() {
  return activeConnections.size;
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
  res.write(`data: ${JSON.stringify({ type: "transport", ...getTransportState() })}\n\n`);
  if (updateInfo) res.write(`data: ${JSON.stringify({ type: "updateAvailable", ...updateInfo })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

export function handleStateGet(req, res) {
  jsonOk(res, { ...uiState, ...cachedPermissions, desktopEnabled, remoteAvailable, transport: getTransportState() });
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
  updateUiState({ step: STEP.PREPARING, stepDesc: "", tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null });
  writeCmd("restart-tunnel");
}

export function handleStart(req, res) {
  jsonOk(res);
  updateUiState({ step: STEP.PREPARING, stepDesc: "" });
  writeCmd("start-tunnel");
}

export function handleStopTunnel(req, res) {
  jsonOk(res);
  updateUiState({ step: STEP.STOPPED, stepDesc: "", tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "" });
  writeCmd("stop-tunnel");
}

export function handleShutdown(req, res) {
  jsonOk(res);
  updateUiState({ step: STEP.STOPPED, stepDesc: "", tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "" });
  writeCmd("shutdown");
}

// Web triggers update; CLI process (cmdPoller) does the actual work, not the server
export function handleUpdate(req, res) {
  jsonOk(res);
  writeCmd("update");
}

export function handleConnections(req, res) {
  jsonOk(res, { connections: [...activeConnections.values()] });
}

export function handleLogsGet(req, res) {
  const url = new URL(req.url, "http://localhost");
  const n = parseInt(url.searchParams.get("lines") || LOG_TAIL_LINES, 10);
  jsonOk(res, { logs: readRecentLogs(Number.isFinite(n) ? n : LOG_TAIL_LINES) });
}

export function handleLogsClear(req, res) {
  clearRecentLogs();
  jsonOk(res, { ok: true });
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
      let granted = false;
      try {
        granted = !!(await refreshPermissionsAsync())[type];
      } catch (err) {
        logger.error(`permission poll failed: ${err?.message || err}`);
      }
      if (granted || Date.now() - started > PERMISSION_POLL_FAST_DURATION) clearInterval(poll);
    }, PERMISSION_POLL_FAST_MS);
  }
  jsonOk(res);
}
