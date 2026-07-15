// Transport server: WS entry point + future protocols
import { Server } from "socket.io";
import { readFileSync } from "fs";
import { join } from "path";
import { PATHS, LOCAL_UI_ORIGINS, LOCAL_UI_DEVICE_ID } from "../lib/constants.js";
import { verifyLocalToken } from "../lib/localToken.js";
import { ProtocolManager } from "./ProtocolManager.js";
import { registerProtocol, unregisterProtocol } from "./broadcast.js";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import { setupTerminalSocket, setupTerminalHandlers } from "../features/terminal/terminalSocket.js";
import { checkRemoteAvailable } from "../features/remote/remoteSocket.js";
import { setupFileExplorerHandlers } from "../features/fileExplorer/fileExplorerSocket.js";
import { setupClipboardHandlers } from "../features/clipboard/clipboardSocket.js";
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
  clearRejectedDevice,
  loadAutoApprove,
  isAutoApprove
} from "../lib/deviceApproval.js";

function loadApiKey() {
  try {
    const keysFile = join(PATHS.ROOT, "keys.json");
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

/** Setup all per-socket features on an approved socket (single entry point).
 * Order matters: transport bus MUST be ready before terminal/remote handlers so the
 * first tile frame isn't dropped (black canvas). File + terminal + remote all live here. */
async function setupSocketFeatures(socket) {
  // Clear one-time key if used
  if (socket.handshake.auth?.tempKey) {
    pushUiLog("One-time key used \u2014 clearing from UI");
    clearOneTimeKey();
  }
  await attachTransportBus(socket);
  setupFileExplorerHandlers(socket);
  setupClipboardHandlers(socket);
  await setupTerminalHandlers(socket, ioInstance, loadApiKey());
}

/** Create connection-level PM and route socket.emit through it (DRY transport bus).
 * Awaits pm.init() so the ws adapter is ready before tiles stream (else first frame
 * is dropped by sendTiles while checksums are already marked sent → black canvas). */
async function attachTransportBus(socket) {
  if (socket.data.protocol) return;
  const { webrtc, streaming } = REMOTE_CONFIG;
  const pm = new ProtocolManager(socket, {
    enableWebRTC: webrtc.enableWebRTC,
    apiKey: webrtc.enableTurn ? loadApiKey() : null,
    turnApiUrl: webrtc.enableTurn ? webrtc.turnApiUrl : null,
    turnRefreshInterval: webrtc.turnRefreshInterval,
    dcMaxMessageSize: webrtc.dcMaxMessageSize,
    dcChunkSize: webrtc.dcChunkSize,
    dcMaxTilesPerFrame: webrtc.dcMaxTilesPerFrame,
    answerTimeout: webrtc.answerTimeout,
    maxControlBuffer: webrtc.maxControlBuffer,
    wsChunkSize: streaming.chunkSize
  });
  socket.data.protocol = pm;
  registerProtocol(pm);
  pm.attachAsBus(socket);
  try {
    await pm.init();
    pm.setupSignaling(socket);
  } catch (e) {
    console.error("[transport] pm init failed:", e.message);
  }
}

/** Approve a pending socket by socketId */
export function approveSocketDevice(socketId) {
  const io = ioInstance;
  if (!io) return false;

  const socket = io.sockets.sockets.get(socketId);
  const pending = getPendingApproval(socketId);
  if (!socket || !pending) return false;

  // Save device as approved; clear any prior rejection
  approveDevice(pending.deviceId);
  removePendingApproval(socketId);
  clearRejectedDevice(pending.deviceId);

  // Unlock socket + notify client
  socket.data.approved = true;
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

export async function startTransportServer(server) {
  // Load approved devices + auto-approve setting from disk
  loadApprovedDevices();
  loadAutoApprove();

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
    maxHttpBufferSize: 1e8,
    perMessageDeflate: { threshold: 1024 }
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

    // Trusted local UI — valid ephemeral token + loopback + same-origin (or non-browser).
    // Resists CSWSH: a malicious page can't read the token (loopback + origin-guarded endpoint).
    const rawAddr = socket.handshake.address || "";
    const isLoopback = rawAddr === "127.0.0.1" || rawAddr === "::1" || rawAddr === "::ffff:127.0.0.1";
    const isTunnel = !!socket.handshake.headers["cf-connecting-ip"];
    const origin = socket.handshake.headers.origin;
    const originOk = !origin || LOCAL_UI_ORIGINS.includes(origin);
    if (!isTunnel && isLoopback && originOk && verifyLocalToken(socket.handshake.auth?.localToken)) {
      socket.data.approved = true;
      socket.data.localUi = true;
      pushUiLog("Local UI connected — trusted (token)");
      setupSocketFeatures(socket);
      return; // do not track in Clients list
    }

    // Reserved local-ui deviceId that failed trust check → spoof attempt, reject.
    if (deviceId === LOCAL_UI_DEVICE_ID) {
      pushUiLog(`Rejected untrusted local-ui socket from ${ip}`);
      socket.disconnect(true);
      return;
    }

    trackConnection(socket.id, ip, deviceId);
    pushUiLog(`Client connected: ${ip} (device: ${deviceId?.slice(0, 8) || "none"})`);

    socket.on("disconnect", (reason) => {
      untrackConnection(socket.id);
      removePendingApproval(socket.id);
      pushUiLog(`Client disconnected: ${ip} (${reason})`);
      // PM cleanup deferred: remoteSocket grace timer handles it if remote was attached;
      // otherwise close immediately
      const pm = socket.data?.protocol;
      if (pm && !socket.data?.remoteAttached) {
        try { pm.close(); } catch {}
        unregisterProtocol(pm);
      }
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
    } else if (deviceId && isAutoApprove()) {
      // Auto-approve enabled — skip pending flow, approve immediately
      approveDevice(deviceId);
      clearRejectedDevice(deviceId);
      socket.data.approved = true;
      pushUiLog(`Auto-approved device: ${deviceId.slice(0, 8)}...`);
      setupSocketFeatures(socket);
      // Notify client after it signals ready so listeners are attached
      socket.once("device:clientReady", () => socket.emit("device:approved"));
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

  // Init terminal broadcast + serverInfo builder (per-socket handlers wired in setupSocketFeatures)
  setupTerminalSocket(io, loadApiKey());

  ioInstance = io;
  return io;
}
