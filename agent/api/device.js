/**
 * Device approval handlers (localhost-only)
 */

import { jsonOk, jsonErr, parseJsonBody } from "../lib/router.js";
import { approveSocketDevice, rejectSocketDevice, disconnectDeviceSockets, approveRejectedDevice } from "../lib/socketio.js";
import { getAllPendingApprovals, getApprovedDevices, removeDevice, getRejectedDevices, clearRejectedDevice, isAutoApprove, setAutoApprove } from "../lib/deviceApproval.js";

export async function handleApprove(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const ok = approveSocketDevice(data.socketId);
  jsonOk(res, { ok });
}

export async function handleReject(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const ok = rejectSocketDevice(data.socketId);
  jsonOk(res, { ok });
}

export function handlePending(req, res) {
  jsonOk(res, { pending: getAllPendingApprovals() });
}

export function handleApproved(req, res) {
  jsonOk(res, { devices: getApprovedDevices() });
}

export function handleRejected(req, res) {
  jsonOk(res, { rejected: getRejectedDevices() });
}

export async function handleApproveRejected(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const ok = approveRejectedDevice(data.deviceId);
  jsonOk(res, { ok });
}

export async function handleClearRejected(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return;
  disconnectDeviceSockets(data.deviceId);
  clearRejectedDevice(data.deviceId);
  jsonOk(res);
}

export async function handleRemove(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return;
  disconnectDeviceSockets(data.deviceId);
  removeDevice(data.deviceId);
  jsonOk(res);
}

export async function handleDisconnect(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const count = disconnectDeviceSockets(data.deviceId);
  jsonOk(res, { disconnected: count });
}

export function handleGetAutoApprove(req, res) {
  jsonOk(res, { enabled: isAutoApprove() });
}

export async function handleSetAutoApprove(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const enabled = setAutoApprove(!!data.enabled);
  jsonOk(res, { enabled });
}
