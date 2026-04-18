// Main Socket.IO setup
import { Server } from "socket.io";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { setupTerminalSocket } from "../features/terminal/terminalSocket.js";
import { setupRemoteSocket, checkRemoteAvailable } from "../features/remote/remoteSocket.js";
import { setupFileExplorerSocket } from "../features/fileExplorer/fileExplorerSocket.js";
import { trackConnection, untrackConnection, pushUiLog, clearOneTimeKey, pushUiEvent, setRemoteAvailable } from "../api/ui.js";
import {
  loadApprovedDevices,
  isDeviceApproved,
  isDevicePending,
  approveDevice,
  addPendingApproval,
  removePendingApproval,
  getPendingApproval,
  markDeviceRejected,
  isDeviceRejected,
  updateRejectedSocket,
  clearRejectedDevice
} from "./deviceApproval.js";

function loadApiKey() {
  try {
    const keysFile = join(homedir(), ".9remote", "keys.json");
    const data = JSON.parse(readFileSync(keysFile, "utf8"));
    return data.key || null;
  } catch {
    return null;
  }
}

let ioInstance = null;

export function getIO() {
  return ioInstance;
}

/** Setup features on an approved socket */
function setupSocketFeatures(socket) {
  // Clear one-time key if used
  if (socket.handshake.auth?.tempKey) {
    pushUiLog("One-time key used \u2014 clearing from UI");
    clearOneTimeKey();
  }
}

/** Approve a pending socket by socketId */
export function approveSocketDevice(socketId) {
  const io = ioInstance;
  if (!io) return false;

  const socket = io.sockets.sockets.get(socketId);
  const pending = getPendingApproval(socketId);
  console.log(`[DEBUG-APPROVE] socketId=${socketId}, socketExists=${!!socket}, pendingExists=${!!pending}`);
  if (!socket || !pending) return false;

  // Save device as approved; clear any prior rejection
  approveDevice(pending.deviceId);
  removePendingApproval(socketId);
  clearRejectedDevice(pending.deviceId);

  // Unlock socket + notify client
  socket.data.approved = true;
  console.log(`[DEBUG-APPROVE] Emitting device:approved to ${socketId}`);
  socket.emit("device:approved");

  // Setup features
  setupSocketFeatures(socket);
  pushUiLog(`Device approved: ${pending.deviceId.slice(0, 8)}...`);

  return true;
}

/** Approve a previously-rejected device by deviceId (from Clients list) */
export function approveRejectedDevice(deviceId) {
  const io = ioInstance;
  if (!io || !deviceId) return false;

  approveDevice(deviceId);
  clearRejectedDevice(deviceId);

  // Notify any active socket for this device
  for (const socket of io.sockets.sockets.values()) {
    if (socket.handshake.auth?.deviceId === deviceId) {
      socket.data.approved = true;
      socket.emit("device:approved");
      setupSocketFeatures(socket);
    }
  }
  pushUiLog(`Device approved from pending: ${deviceId.slice(0, 8)}...`);
  return true;
}

/** Disconnect all active sockets belonging to a deviceId (device stays approved) */
export function disconnectDeviceSockets(deviceId) {
  const io = ioInstance;
  if (!io || !deviceId) return 0;
  let count = 0;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.handshake.auth?.deviceId === deviceId) {
      socket.disconnect(true);
      count++;
    }
  }
  if (count) pushUiLog(`Disconnected ${count} socket(s) for device ${deviceId.slice(0, 8)}...`);
  return count;
}

/** Reject a pending socket by socketId (remember deviceId in RAM as pending) */
export function rejectSocketDevice(socketId) {
  const io = ioInstance;
  if (!io) return false;

  const pending = getPendingApproval(socketId);
  const socket = io.sockets.sockets.get(socketId);
  removePendingApproval(socketId);

  // Remember rejection in RAM so it shows up in Clients list as pending
  if (pending?.deviceId) {
    markDeviceRejected(pending.deviceId, { ip: pending.ip, socketId });
  }

  if (socket) {
    socket.emit("device:rejected");
    socket.disconnect(true);
  }

  // Notify UI to refresh pending/approved list
  pushUiEvent("deviceApproval", { action: "refresh" });
  pushUiLog(`Device rejected: ${pending?.deviceId?.slice(0, 8) || "unknown"}...`);
  return true;
}

export async function setupSocketIO(server) {
  // Load approved devices from disk
  loadApprovedDevices();

  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true,
      allowedHeaders: ["*"]
    },
    transports: ["websocket", "polling"],
    allowEIO3: true,
    allowUpgrades: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8
  });

  // Check remote availability at startup
  const hasRemote = await checkRemoteAvailable();
  setRemoteAvailable(hasRemote);

  // Track connections + device approval
  io.on("connection", (socket) => {
    const ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "unknown";
    const deviceId = socket.handshake.auth?.deviceId || null;

    // Block all events from unapproved sockets (except device:clientReady)
    socket.data.approved = false;
    socket.use((packet, next) => {
      if (socket.data.approved) return next();
      const event = packet[0];
      if (event === "device:clientReady" || event === "disconnect") return next();
      return next(new Error("Device not approved"));
    });

    trackConnection(socket.id, ip, deviceId);
    pushUiLog(`Client connected: ${ip} (device: ${deviceId?.slice(0, 8) || "none"})`);

    socket.on("disconnect", (reason) => {
      untrackConnection(socket.id);
      removePendingApproval(socket.id);
      pushUiLog(`Client disconnected: ${ip} (${reason})`);
    });

    // Check device approval
    if (deviceId && isDeviceApproved(deviceId)) {
      // Known device — allow immediately
      pushUiLog(`Device recognized: ${deviceId.slice(0, 8)}...`);
      socket.data.approved = true;
      setupSocketFeatures(socket);
    } else if (deviceId && isDeviceRejected(deviceId)) {
      // Previously rejected — keep socket unapproved, no modal, update socketId for later approve
      updateRejectedSocket(deviceId, socket.id, ip);
      pushUiLog(`Rejected device reconnected: ${deviceId.slice(0, 8)} — waiting in Clients list`);
      socket.emit("device:rejected");
      pushUiEvent("deviceApproval", { action: "refresh" });
    } else {
      // Unknown device — hold and request approval
      pushUiLog(`Unknown device: ${deviceId?.slice(0, 8) || "no-id"} — waiting for approval`);
      // Skip if same deviceId already pending (client reconnected)
      if (isDevicePending(deviceId)) {
        pushUiLog(`Device ${deviceId?.slice(0, 8)} already pending, ignoring duplicate`);
        socket.disconnect(true);
        return;
      }

      addPendingApproval(socket.id, { deviceId, ip });

      // Wait for client to signal ready before emitting approval request
      socket.once("device:clientReady", () => {
        socket.emit("device:pendingApproval");
        pushUiEvent("deviceApproval", {
          socketId: socket.id,
          deviceId,
          ip,
          action: "pending"
        });
      });
    }
  });

  // Setup Terminal + Remote on same root namespace
  setupTerminalSocket(io, loadApiKey());

  // Setup File Explorer (uses default namespace)
  setupFileExplorerSocket(io);

  ioInstance = io;
  return io;
}
