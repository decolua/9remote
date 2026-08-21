/**
 * Device approval manager — persists approved deviceIds to ~/.9remote/approvedDevices.json
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { writeJsonAtomic } from "./atomicFile.js";
import { join } from "path";
import { PATHS, LOCAL_UI_DEVICE_ID } from "./constants.js";
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

// Kicked via "Disconnect" (RAM only): still approved on disk, but the next
// connect must be re-approved — clears on approve/reject/remove or restart.
const kickedDevices = new Set();

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
      // Drop reserved local-ui id from legacy files (never a real client)
      if (approvedDevices.delete(LOCAL_UI_DEVICE_ID)) saveApprovedDevices();
    }
  } catch {
    approvedDevices = new Map();
  }
}

function saveApprovedDevices() {
  try {
    ensureDir();
    writeJsonAtomic(DEVICES_FILE, Object.fromEntries(approvedDevices));
  } catch {}
}

export function isDeviceApproved(deviceId) {
  if (!deviceId) return false;
  return approvedDevices.has(deviceId);
}

// Single decision table for every inbound connection, regardless of carrier.
// A kicked device asks again even with auto-approve on — the host's explicit
// Disconnect must not be instantly undone.
export function gateDevice(deviceId) {
  if (deviceId && kickedDevices.has(deviceId)) return "unknown";
  if (deviceId && isDeviceApproved(deviceId)) return "approved";
  if (deviceId && isDeviceRejected(deviceId)) return "rejected";
  if (isAutoApprove()) return "auto";
  return "unknown";
}

export function kickDevice(deviceId) {
  if (!deviceId || deviceId === LOCAL_UI_DEVICE_ID) return;
  kickedDevices.add(deviceId);
}

export function isDeviceKicked(deviceId) {
  return kickedDevices.has(deviceId);
}

export function approveDevice(deviceId) {
  if (!deviceId || deviceId === LOCAL_UI_DEVICE_ID) return;
  kickedDevices.delete(deviceId);
  // Preserve meta (secret, label) — re-approving a device must not silently
  // strip its enrollment back to the string-only check.
  approvedDevices.set(deviceId, { ...approvedDevices.get(deviceId), approvedAt: new Date().toISOString() });
  saveApprovedDevices();
}

export function removeDevice(deviceId) {
  kickedDevices.delete(deviceId);
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

// ── TAIL proof state ────────────────────────────────────────────────────────
// Approval ("the host allows this device") and proof ("this device holds the
// key TAIL") are separate things. Proof belongs to the KEY, so the record is
// which key HEAD the device proved against — not a boolean. Regenerating the
// key retires every old proof: no client can hold a TAIL that no longer
// exists, and demanding one would lock everyone out of their own machine.
//
// Devices approved before the split (or paired with a v1 key) never prove, so
// they carry no record and stay on the legacy path.

export function hasProvenTail(deviceId, keyHead) {
  const proven = approvedDevices.get(deviceId)?.provenKey;
  return !!proven && !!keyHead && proven === keyHead;
}

export function markTailProven(deviceId, keyHead) {
  const meta = approvedDevices.get(deviceId);
  if (!meta || !keyHead || meta.provenKey === keyHead) return;
  approvedDevices.set(deviceId, { ...meta, provenKey: keyHead });
  saveApprovedDevices();
}

export function getApprovedDevices() {
  // Never expose the device secret through the API/UI
  return [...approvedDevices.entries()].map(([id, meta]) => ({ deviceId: id, approvedAt: meta.approvedAt, label: meta.label || "" }));
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

// socketId currently holding this device's pending entry (approval is per device)
export function getPendingSocketId(deviceId) {
  if (!deviceId) return null;
  for (const [socketId, data] of pendingApprovals) {
    if (data.deviceId === deviceId) return socketId;
  }
  return null;
}

export function getAllPendingApprovals() {
  return [...pendingApprovals.entries()].map(([socketId, data]) => ({ socketId, ...data }));
}

// Rejected devices (pending re-approval from Clients list)
export function markDeviceRejected(deviceId, data) {
  if (!deviceId) return;
  kickedDevices.delete(deviceId); // rejected supersedes kicked
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
