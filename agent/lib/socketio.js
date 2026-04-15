// Main Socket.IO setup
import { Server } from "socket.io";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { setupTerminalSocket } from "../features/terminal/terminalSocket.js";
import { setupRemoteSocket, checkRemoteAvailable } from "../features/remote/remoteSocket.js";
import { setupFileExplorerSocket } from "../features/fileExplorer/fileExplorerSocket.js";
import { trackConnection, untrackConnection, pushUiLog, clearOneTimeKey, pushUiEvent } from "../index.js";
import {
  loadApprovedDevices,
  isDeviceApproved,
  isDevicePending,
  approveDevice,
  addPendingApproval,
  removePendingApproval,
  getPendingApproval
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

  // Save device as approved
  approveDevice(pending.deviceId);
  removePendingApproval(socketId);

  // Unlock socket + notify client
  socket.data.approved = true;
  console.log(`[DEBUG-APPROVE] Emitting device:approved to ${socketId}`);
  socket.emit("device:approved");

  // Setup features
  setupSocketFeatures(socket);
  pushUiLog(`Device approved: ${pending.deviceId.slice(0, 8)}...`);

  return true;
}

/** Reject a pending socket by socketId */
export function rejectSocketDevice(socketId) {
  const io = ioInstance;
  if (!io) return false;

  const pending = getPendingApproval(socketId);
  const socket = io.sockets.sockets.get(socketId);
  removePendingApproval(socketId);

  if (socket) {
    socket.emit("device:rejected");
    socket.disconnect(true);
  }

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
    pingInterval: 25000
  });

  // Check remote availability at startup
  await checkRemoteAvailable();

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

    trackConnection(socket.id, ip);
    pushUiLog(`Client connected: ${ip} (device: ${deviceId?.slice(0, 8) || "none"})`);

    socket.on("disconnect", (reason) => {
      untrackConnection(socket.id);
      removePendingApproval(socket.id);
      pushUiLog(`Client disconnected: ${ip} (${reason})`);
    });

    // Check device approval
    console.log(`[DEBUG-SOCKET] connection: socketId=${socket.id}, deviceId=${deviceId?.slice(0,8)}, approved=${isDeviceApproved(deviceId)}, pending=${isDevicePending(deviceId)}`);
    if (deviceId && isDeviceApproved(deviceId)) {
      // Known device — allow immediately
      pushUiLog(`Device recognized: ${deviceId.slice(0, 8)}...`);
      socket.data.approved = true;
      setupSocketFeatures(socket);
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
        console.log(`[DEBUG-SOCKET] clientReady received: socketId=${socket.id}, deviceId=${deviceId?.slice(0,8)}`);
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
