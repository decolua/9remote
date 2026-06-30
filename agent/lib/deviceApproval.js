/**
 * Device approval manager — persists approved deviceIds to ~/.9remote/approvedDevices.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { PATHS } from "./constants.js";
import { readSettings, writeSettings } from "./settings.js";

const STATE_DIR = PATHS.CONFIG;
const DEVICES_FILE = join(PATHS.CONFIG, "approvedDevices.json");

// deviceId -> { approvedAt }
let approvedDevices = new Map();

// Auto-approve new device connections (default false). Persisted to config.json.
let autoApprove = false;

// Pending approval requests: socketId -> { deviceId, ip }
const pendingApprovals = new Map();

// Rejected devices (RAM only, cleared on restart): deviceId -> { ip, rejectedAt, socketId }
const rejectedDevices = new Map();

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

export function loadApprovedDevices() {
  try {
    ensureDir();
    if (existsSync(DEVICES_FILE)) {
      const data = JSON.parse(readFileSync(DEVICES_FILE, "utf8"));
      // Migrate from old array format to new map format
      if (Array.isArray(data)) {
        approvedDevices = new Map(data.map((id) => [id, { approvedAt: null }]));
      } else {
        approvedDevices = new Map(Object.entries(data));
      }
    }
  } catch {
    approvedDevices = new Map();
  }
}

function saveApprovedDevices() {
  try {
    ensureDir();
    writeFileSync(DEVICES_FILE, JSON.stringify(Object.fromEntries(approvedDevices), null, 2));
  } catch {}
}

export function isDeviceApproved(deviceId) {
  if (!deviceId) return false;
  return approvedDevices.has(deviceId);
}

export function approveDevice(deviceId) {
  if (!deviceId) return;
  approvedDevices.set(deviceId, { approvedAt: new Date().toISOString() });
  saveApprovedDevices();
}

export function removeDevice(deviceId) {
  approvedDevices.delete(deviceId);
  saveApprovedDevices();
}

export function setDeviceLabel(deviceId, label) {
  const meta = approvedDevices.get(deviceId);
  if (!meta) return false;
  approvedDevices.set(deviceId, { ...meta, label: label || "" });
  saveApprovedDevices();
  return true;
}

export function getApprovedDevices() {
  return [...approvedDevices.entries()].map(([id, meta]) => ({ deviceId: id, ...meta }));
}

// Pending approval queue
export function addPendingApproval(socketId, data) {
  pendingApprovals.set(socketId, data);
}

export function getPendingApproval(socketId) {
  return pendingApprovals.get(socketId) || null;
}

export function removePendingApproval(socketId) {
  pendingApprovals.delete(socketId);
}

export function isDevicePending(deviceId) {
  if (!deviceId) return false;
  for (const data of pendingApprovals.values()) {
    if (data.deviceId === deviceId) return true;
  }
  return false;
}

export function getAllPendingApprovals() {
  return [...pendingApprovals.entries()].map(([socketId, data]) => ({ socketId, ...data }));
}

// Rejected devices (pending re-approval from Clients list)
export function markDeviceRejected(deviceId, data) {
  if (!deviceId) return;
  rejectedDevices.set(deviceId, { ...data, rejectedAt: new Date().toISOString() });
}

export function isDeviceRejected(deviceId) {
  if (!deviceId) return false;
  return rejectedDevices.has(deviceId);
}

export function updateRejectedSocket(deviceId, socketId, ip) {
  const entry = rejectedDevices.get(deviceId);
  if (entry) rejectedDevices.set(deviceId, { ...entry, socketId, ip });
}

export function getRejectedDevices() {
  return [...rejectedDevices.entries()].map(([deviceId, meta]) => ({ deviceId, ...meta }));
}

export function clearRejectedDevice(deviceId) {
  rejectedDevices.delete(deviceId);
}

// ── Auto-approve setting (persisted in settings.json) ───────────────
export function loadAutoApprove() {
  autoApprove = !!readSettings().autoApprove;
  return autoApprove;
}

export function isAutoApprove() {
  return autoApprove;
}

export function setAutoApprove(enabled) {
  autoApprove = !!enabled;
  writeSettings({ autoApprove });
  return autoApprove;
}
