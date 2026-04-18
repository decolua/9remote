/**
 * UI state & SSE event handlers (localhost-only)
 */

import { STEP } from "../lib/constants.js";
import { writeCmd } from "../cli/utils/state.js";
import { checkPermissions, openPermissionPane } from "../cli/utils/permissions.js";
import { jsonOk } from "../lib/router.js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || ".";
const NINE_REMOTE_DIR = join(HOME_DIR, ".9remote");
const UI_STATE_FILE = join(NINE_REMOTE_DIR, "ui-state.json");
const DESKTOP_STATE_FILE = join(NINE_REMOTE_DIR, "desktop.json");

function ensureDir() {
  mkdirSync(NINE_REMOTE_DIR, { recursive: true });
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
  try {
    if (existsSync(DESKTOP_STATE_FILE)) {
      desktopEnabled = !!JSON.parse(readFileSync(DESKTOP_STATE_FILE, "utf8")).enabled;
    }
  } catch { }
}

function saveDesktopState() {
  try {
    ensureDir();
    writeFileSync(DESKTOP_STATE_FILE, JSON.stringify({ enabled: desktopEnabled }));
  } catch { }
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

export function refreshPermissionsAsync() {
  checkPermissions().then((p) => { cachedPermissions = p; });
}

export function trackConnection(socketId, ip, deviceId = null, type = "ws") {
  activeConnections.set(socketId, { socketId, ip, deviceId, type, connectedAt: Date.now() });
  pushUiEvent("connections", { connections: [...activeConnections.values()] });
}

export function untrackConnection(socketId) {
  activeConnections.delete(socketId);
  pushUiEvent("connections", { connections: [...activeConnections.values()] });
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

export function handleConnections(req, res) {
  jsonOk(res, { connections: [...activeConnections.values()] });
}

export async function handleDesktopToggle(req, res) {
  const { parseJsonBody } = await import("../lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  desktopEnabled = !!data.enabled;
  saveDesktopState();
  pushUiEvent("permissions", { ...cachedPermissions, desktopEnabled });
  jsonOk(res, { ok: true, enabled: desktopEnabled });
}

export function handlePermissionsGet(req, res) {
  jsonOk(res, cachedPermissions);
}

export async function handlePermissionsRequest(req, res) {
  const { parseJsonBody } = await import("../lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const { type } = data;
  if (process.platform === "darwin") {
    openPermissionPane(type);
    // Poll for permission grant
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      checkPermissions().then((p) => {
        cachedPermissions = p;
        if (p[type] || attempts >= 30) {
          clearInterval(poll);
          pushUiEvent("permissions", { ...cachedPermissions, desktopEnabled });
        }
      });
    }, 2000);
  }
  jsonOk(res);
}
