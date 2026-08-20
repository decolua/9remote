// Transport server: WS entry point + future protocols
import { Server } from "socket.io";
import { readFileSync } from "fs";
import { join } from "path";
import { initSignalingGlobal, setOfferFallback, sendSignaling, dropPending, pendingPeersOf, onSignalingReady, hasPendingOffer } from "../lib/signalingGlobal.js";
import { VirtualSocket } from "./VirtualSocket.js";
import { PATHS, LOCAL_UI_ORIGINS, LOCAL_UI_DEVICE_ID } from "../lib/constants.js";
import { verifyLocalToken } from "../lib/localToken.js";
import { ProtocolManager } from "./ProtocolManager.js";
import { SIGNALING_ERRORS } from "../lib/transportConstants.js";
import { registerProtocol, unregisterProtocol, disableAllRtc, notifyRtcEnabled } from "./broadcast.js";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import { setupTerminalSocket, setupTerminalHandlers } from "../features/terminal/terminalSocket.js";
import { checkRemoteAvailable } from "../features/remote/remoteSocket.js";
import { setupFileExplorerHandlers } from "../features/fileExplorer/fileExplorerSocket.js";
import { setupClipboardHandlers } from "../features/clipboard/clipboardSocket.js";
import { setupQuotaTrackerHandlers } from "../features/quotaTracker/quotaTrackerSocket.js";
import { trackConnection, untrackConnection, pushUiLog, pushUiLogDebug, clearOneTimeKey, pushUiEvent, setRemoteAvailable, pushTransportState } from "../api/ui.js";
import {
  loadApprovedDevices,
  isDeviceApproved,
  isDevicePending,
  approveDevice,
  addPendingApproval,
  removePendingApproval,
  getPendingApproval,
  getPendingSocketId,
  markDeviceRejected,
  isDeviceRejected,
  updateRejectedSocket,
  getRejectedDevices,
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
 * first tile frame isn't dropped (black canvas). File + terminal + remote all live here.
 * Emits "terminal:ready" once handlers are registered so the client can fetch sessions
 * without racing the async setup (F5 was landing getSessions before getSessions handler). */
async function setupSocketFeatures(socket) {
  // Clear one-time key if used
  if (socket.handshake.auth?.tempKey) {
    pushUiLog("One-time key used \u2014 clearing from UI");
    clearOneTimeKey();
  }
  await attachTransportBus(socket);
  setupFileExplorerHandlers(socket);
  setupClipboardHandlers(socket);
  setupQuotaTrackerHandlers(socket);
  await setupTerminalHandlers(socket, ioInstance, loadApiKey());
  socket.emit("terminal:ready");
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
    wsChunkSize: streaming.chunkSize,
    // DO signaling relay — room = client deviceId, gated by apiKey on the Worker.
    signaling: {
      // Always route by peerId (deviceId:tab) — the client's offer arrives with
      // from=peerId, so the PM must register its handler under that exact key or
      // signalingGlobal won't find it and will spawn a second RTC-only PM (→ the
      // two-PM duplicate-output bug). VirtualSocket has .peerId; a real socket.io
      // socket carries it in handshake.auth.peerId (set by the client).
      deviceId: socket.peerId || socket.handshake.auth?.peerId || socket.handshake.auth?.deviceId || null,
      doUrl: webrtc.signalingDoUrl,
      apiKey: loadApiKey()
    }
  });
  socket.data.protocol = pm;
  // Virtual session: RTC dying with no WS fallback means the session is over.
  if (socket.isVirtual) {
    pm._onDead = () => {
      pushUiLogDebug(`RTC session closed: ${socket.handshake.auth?.deviceId?.slice(0, 8)}...`);
      try { pm.close(); } catch {}
      unregisterProtocol(pm);
      socket.disconnect();
    };
  }
  registerProtocol(pm);
  pm.attachAsBus(socket);
  try {
    await pm.init();
    pm.setupSignaling(socket);
  } catch (e) {
    console.error("[transport] pm init failed:", e.message);
  }
}

// RTC-only sessions keyed by client peerId ("deviceId:tab") — created when an
// offer arrives over DO signaling before the tunnel brought socket.io up.
const rtcSessions = new Map();

// Debug toggle — when false, the agent refuses RTC offers so clients fall back
// to the tunnel. Lets you test the fallback path without pulling the network.
let rtcTestDisabled = false;

export function isRtcTestDisabled() { return rtcTestDisabled; }
export function setRtcTestDisabled(disabled) {
  rtcTestDisabled = disabled;
  if (!disabled) {
    // RTC re-enabled: tell clients to clear their stop-retry flag and renegotiate.
    notifyRtcEnabled();
    return;
  }
  // RTC now lives inside the WS-hosted PM (not rtcSessions), so tear it down
  // across every active PM. The client then falls back to the WS tunnel.
  disableAllRtc();
  // Also clear VirtualSocket RTC sessions (RTC-first offer-before-WS case).
  for (const [peerId, vs] of rtcSessions) {
    try {
      const pm = vs.data?.protocol;
      try { vs.disconnect(); } catch {}
      if (pm) { try { pm.close(); } catch {} unregisterProtocol(pm); }
    } catch {}
    rtcSessions.delete(peerId);
    pushUiLogDebug(`RTC test-disabled: killed session ${peerId?.slice(0, 8)}`);
  }
}

// Synthetic socketId for a DO peer — lets pending approvals and the Clients
// list address an RTC session with the same key shape as a socket.io socket.
const rtcSocketId = (peerId) => `rtc-${peerId}`;
const rtcPeerId = (socketId) => (socketId.startsWith("rtc-") ? socketId.slice(4) : null);
const sendSignalingTo = (peerId, msg) => sendSignaling({ ...msg, to: peerId });

/** Route an RTC offer that arrived over DO signaling: approved → build the
 * session; unknown → raise the same approval modal as the socket.io path
 * (the offer stays buffered until Approve); rejected → tell the client. */
function handleRtcOffer(peerId) {
  if (!peerId) return;
  // Debug toggle — refuse RTC so the client falls back to the tunnel immediately.
  if (rtcTestDisabled) {
    sendSignalingTo(peerId, { type: "error", message: "rtc-disabled" });
    return;
  }
  // peerId = "deviceId:tab" — one session per tab, approval per device.
  const deviceId = peerId.split(":")[0];

  const existing = rtcSessions.get(peerId);
  if (existing) {
    // Live (or still building — protocol not attached yet) → the offer is
    // already routed to its PM. Only a closed PM is stale and worth rebuilding.
    if (!existing.data.protocol?._closed) return;
    pushUiLogDebug(`Stale RTC session ${deviceId.slice(0, 8)} — rebuilding`);
    try { existing.disconnect(); } catch {}
    rtcSessions.delete(peerId);
  }

  if (isDeviceApproved(deviceId)) return void startRtcSession(peerId, deviceId);

  if (isDeviceRejected(deviceId)) {
    updateRejectedSocket(deviceId, rtcSocketId(peerId), "rtc");
    sendSignalingTo(peerId, { type: "error", message: SIGNALING_ERRORS.rejected });
    dropPending(peerId); // nothing will consume it — don't hold the SDP in RAM
    pushUiLog(`Rejected device via RTC: ${deviceId.slice(0, 8)} — waiting in Clients list`);
    pushUiEvent("deviceApproval", { action: "refresh" });
    return;
  }

  if (isAutoApprove()) {
    approveDevice(deviceId);
    clearRejectedDevice(deviceId);
    pushUiLog(`Auto-approved device: ${deviceId.slice(0, 8)}...`);
    pushUiEvent("deviceApproval", { action: "refresh" });
    return void startRtcSession(peerId, deviceId);
  }

  // Unknown device — same pending flow as socket.io. The offer stays buffered
  // in signalingGlobal; approveSocketDevice builds the session and flushes it.
  // Tell the client so it shows the "waiting for approval" screen (the socket.io
  // path sends device:pendingApproval; over DO the only channel is signaling).
  sendSignalingTo(peerId, { type: "error", message: SIGNALING_ERRORS.pending });
  // Approval is per device — a second tab reuses the first tab's pending entry.
  if (isDevicePending(deviceId)) return;
  const socketId = rtcSocketId(peerId);
  addPendingApproval(socketId, { deviceId, ip: "rtc", peerId });
  pushUiLog(`Unknown device (RTC): ${deviceId.slice(0, 8)} — waiting for approval`);
  pushUiEvent("deviceApproval", { socketId, deviceId, ip: "rtc", action: "pending" });
}

/** Approval is per device — build a session for every tab of it still waiting
 * on a buffered offer, so one Approve unblocks all of them. */
function releaseRtcPeers(deviceId) {
  for (const peerId of pendingPeersOf(deviceId)) startRtcSession(peerId, deviceId);
}

/** Fire-and-forget build — every caller is a sync signaling/approval path. */
function startRtcSession(peerId, deviceId) {
  buildRtcSession(peerId, deviceId).catch((e) => {
    const stale = rtcSessions.get(peerId);
    if (stale) {
      try { stale.data.protocol?.close(); } catch {}
      unregisterProtocol(stale.data.protocol);
      stale.disconnect();
    }
    rtcSessions.delete(peerId);
    pushUiLog(`RTC session failed: ${e.message}`);
  });
}

/** Build the virtual socket + PM for an approved RTC peer. */
async function buildRtcSession(peerId, deviceId) {
  if (rtcSessions.has(peerId)) return;
  const socket = new VirtualSocket({ deviceId, peerId, apiKey: loadApiKey() });
  socket.data.approved = true;
  socket.data.rtcSession = true;
  rtcSessions.set(peerId, socket);
  trackConnection(socket.id, "rtc", deviceId, "rtc");
  socket.on("disconnect", () => {
    if (rtcSessions.get(peerId) === socket) rtcSessions.delete(peerId);
    untrackConnection(socket.id);
  });
  pushUiLogDebug(`RTC session: ${deviceId.slice(0, 8)}...`);
  await setupSocketFeatures(socket);
  // Client waits for this before loading sessions (mirrors the socket.io path).
  socket.once("device:clientReady", () => socket.emit("device:approved"));
  socket.emit("device:approved");
}

/** Approve a pending socket by socketId */
export function approveSocketDevice(socketId) {
  const io = ioInstance;
  if (!io) return false;

  const pending = getPendingApproval(socketId);
  if (!pending) return false;

  // RTC-only peer (no socket.io) — approve, then build a session per waiting
  // tab so every buffered offer flushes through its new PM handler.
  if (rtcPeerId(socketId)) {
    approveDevice(pending.deviceId);
    removePendingApproval(socketId);
    clearRejectedDevice(pending.deviceId);
    releaseRtcPeers(pending.deviceId);
    pushUiLog(`Device approved (RTC): ${pending.deviceId.slice(0, 8)}...`);
    pushUiEvent("deviceApproval", { action: "refresh" });
    return true;
  }

  const socket = io.sockets.sockets.get(socketId);
  if (!socket) return false;

  // Save device as approved; clear any prior rejection
  approveDevice(pending.deviceId);
  removePendingApproval(socketId);
  clearRejectedDevice(pending.deviceId);

  // Unlock socket + notify client
  socket.data.approved = true;
  socket.emit("device:approved");

  // Setup features — emits "terminal:ready" when handlers are registered
  setupSocketFeatures(socket).catch((e) => pushUiLog(`Feature setup failed: ${e.message}`));
  // Other tabs of this device may be waiting on RTC — approval is per device.
  releaseRtcPeers(pending.deviceId);
  pushUiLog(`Device approved: ${pending.deviceId.slice(0, 8)}...`);

  return true;
}

/** Approve a previously-rejected device by deviceId (from Clients list) */
export function approveRejectedDevice(deviceId) {
  const io = ioInstance;
  if (!io || !deviceId) return false;

  const rejected = getRejectedDevices().find((d) => d.deviceId === deviceId);
  const rtcPeer = rejected?.socketId ? rtcPeerId(rejected.socketId) : null;

  approveDevice(deviceId);
  clearRejectedDevice(deviceId);
  if (rtcPeer) removePendingApproval(rtcSocketId(rtcPeer));
  // Any RTC tab of this device still holding a buffered offer → build now.
  releaseRtcPeers(deviceId);

  // Notify any active socket for this device
  for (const socket of io.sockets.sockets.values()) {
    if (socket.handshake.auth?.deviceId === deviceId) {
      socket.data.approved = true;
      socket.emit("device:approved");
      setupSocketFeatures(socket).catch((e) => pushUiLog(`Feature setup failed: ${e.message}`));
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
  // RTC-only sessions have no socket.io entry — kill them by peerId prefix.
  for (const [peerId, vs] of rtcSessions) {
    if (peerId.split(":")[0] !== deviceId) continue;
    try { vs.data.protocol?.close(); } catch {}
    unregisterProtocol(vs.data.protocol);
    dropPending(peerId);
    vs.disconnect();
    count++;
  }
  if (count) pushUiLogDebug(`Disconnected ${count} socket(s) for device ${deviceId.slice(0, 8)}...`);
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

  // RTC peer — no socket to notify; answer over DO and drop the buffered offer.
  const peerId = rtcPeerId(socketId);
  if (peerId) {
    sendSignalingTo(peerId, { type: "error", message: SIGNALING_ERRORS.rejected });
    dropPending(peerId);
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

  // Join the DO signaling room (room = apiKey) at server boot — independent of
  // any socket.io/tunnel connection. Lets RTC establish before the tunnel is up.
  initSignalingGlobal(loadApiKey());
  // Offer with no PM → build an RTC-only session so login works without a tunnel.
  setOfferFallback(handleRtcOffer);
  onSignalingReady(() => pushTransportState());

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
      pushUiLogDebug("Local UI connected — trusted (token)");
      // emits "terminal:ready" when handlers registered
      setupSocketFeatures(socket).catch((e) => pushUiLog(`Feature setup failed: ${e.message}`));
      return; // do not track in Clients list
    }

    // Reserved local-ui deviceId that failed trust check → spoof attempt, reject.
    if (deviceId === LOCAL_UI_DEVICE_ID) {
      pushUiLog(`Rejected untrusted local-ui socket from ${ip}`);
      socket.disconnect(true);
      return;
    }

    trackConnection(socket.id, ip, deviceId);
    pushUiLogDebug(`Client connected: ${ip} (device: ${deviceId?.slice(0, 8) || "none"})`);

    socket.on("disconnect", (reason) => {
      untrackConnection(socket.id);
      removePendingApproval(socket.id);
      const pm = socket.data?.protocol;
      pushUiLogDebug(`Client disconnected: ${ip} (${reason}) pm=${pm?._deviceId?.slice(0, 12) || "none"} remoteAttached=${!!socket.data?.remoteAttached}`);
      // PM cleanup deferred: remoteSocket grace timer handles it if remote was attached;
      // otherwise close immediately
      if (pm && !socket.data?.remoteAttached) {
        try { pm.close(); } catch {}
        unregisterProtocol(pm);
      }
    });

    // Route this socket: attach to an existing RTC session, wait for an in-flight
    // one, or go through the normal approval + setup. Wrapped in `route()` so the
    // pending-offer grace can re-run it after a brief wait (WS usually arrives
    // before the RTC offer; without waiting we'd build a second PM and broadcast
    // duplicate output to this client).
    const route = () => {
      if (!socket.connected) return; // disconnected during the grace wait
      const peerId = socket.handshake.auth?.peerId || null;
      const rtcSession = peerId ? rtcSessions.get(peerId) : null;
      if (rtcSession && isDeviceApproved(deviceId)) {
        socket.data.approved = true;
        socket.data.rtcHost = rtcSession;
        rtcSession.data.protocol?.attachSocket(socket)
          // The virtual session's terminal:ready rode RTC and could race the client's
          // listener binding — re-emit on this socket so the session list always gets a
          // fetch trigger (client handler is idempotent).
          .then(() => socket.emit("terminal:ready"))
          .catch((e) => pushUiLog(`RTC session attachSocket failed: ${e.message}`));
        pushUiLogDebug(`Tunnel attached to RTC session: ${deviceId.slice(0, 8)}...`);
        socket.once("device:clientReady", () => socket.emit("device:approved"));
        return;
      }

      // WS arrived first but an RTC offer is buffered in signalingGlobal and will
      // build a session momentarily. Wait one grace window instead of spawning a
      // second PM now (which would duplicate-broadcast to this client).
      if (peerId && !socket.data._rtcWaited && hasPendingOffer(peerId)) {
        socket.data._rtcWaited = true;
        pushUiLogDebug(`WS first, RTC offer pending → grace 500ms (device ${deviceId.slice(0, 8)})`);
        setTimeout(route, 500);
        return;
      }

      // Check device approval
      if (deviceId && isDeviceApproved(deviceId)) {
        // Known device — allow immediately
        pushUiLogDebug(`Device recognized: ${deviceId.slice(0, 8)}...`);
        socket.data.approved = true;
        // emits "terminal:ready" when handlers registered
        setupSocketFeatures(socket).catch((e) => pushUiLog(`Feature setup failed: ${e.message}`));
        // Notify client so it reloads sessions/groups after handlers are registered
        socket.once("device:clientReady", () => socket.emit("device:approved"));
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
        // emits "terminal:ready" when handlers registered
        setupSocketFeatures(socket).catch((e) => pushUiLog(`Feature setup failed: ${e.message}`));
        // Notify client after it signals ready so listeners are attached
        socket.once("device:clientReady", () => socket.emit("device:approved"));
        pushUiEvent("deviceApproval", { action: "refresh" });
      } else {
        // Unknown device — hold and request approval
        pushUiLog(`Unknown device: ${deviceId?.slice(0, 8) || "no-id"} — waiting for approval`);
        // Already pending — an RTC peer raised it first. Hand the entry to this
        // real socket so Approve unlocks it and the client gets the waiting modal.
        const prevId = getPendingSocketId(deviceId);
        if (prevId && !rtcPeerId(prevId)) {
          pushUiLogDebug(`Device ${deviceId?.slice(0, 8)} already pending, ignoring duplicate`);
          socket.disconnect(true);
          return;
        }
        if (prevId) removePendingApproval(prevId);

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
    };
    route();
  });

  // Init terminal broadcast + serverInfo builder (per-socket handlers wired in setupSocketFeatures)
  setupTerminalSocket(io, loadApiKey());

  ioInstance = io;
  return io;
}
