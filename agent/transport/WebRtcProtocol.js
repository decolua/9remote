import nodeDataChannel from "node-datachannel";
import { BaseProtocol } from "./BaseProtocol.js";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";

const { PeerConnection } = nodeDataChannel;

const DEFAULT_ICE = [
  { hostname: "stun.cloudflare.com", port: 3478, type: "Stun" }
];

async function fetchTurnIceServers(turnApiUrl, apiKey) {
  try {
    const resp = await fetch(turnApiUrl, { headers: { "X-API-Key": apiKey } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { iceServers } = await resp.json();

    const result = [];
    for (const srv of iceServers) {
      for (const url of srv.urls) {
        if (url.startsWith("stun:")) {
          const host = url.replace("stun:", "").split(":")[0];
          const port = parseInt(url.split(":")[2] || "3478");
          result.push({ hostname: host, port, type: "Stun" });
        } else if (url.startsWith("turn:") || url.startsWith("turns:")) {
          const isTls = url.startsWith("turns:");
          const withoutScheme = url.replace(/^turns?:/, "");
          const hostPort = withoutScheme.split("?")[0];
          const host = hostPort.split(":")[0];
          const port = parseInt(hostPort.split(":")[1] || (isTls ? "5349" : "3478"));
          const transport = url.includes("transport=tcp") ? "Tcp" : "Udp";
          result.push({ hostname: host, port, type: isTls ? "Tls" : "Turn", relayType: transport, username: srv.username, password: srv.credential });
        }
      }
    }
    return result;
  } catch (err) {
    console.error("[WebRtcProtocol] TURN fetch failed:", err.message);
    return null;
  }
}

/**
 * WebRtcProtocol — per-client WebRTC PeerConnection adapter.
 *
 * Handles signaling (offer/answer/ICE) via the WS socket,
 * and exposes sendBinary() to push binary tile frames via DataChannel.
 *
 * Absorbs: WebRTCManager + WebRTCHandler
 */
export class WebRtcProtocol extends BaseProtocol {
  /**
   * @param {object} config
   * @param {string} config.socketId
   * @param {string|null} config.apiKey
   * @param {string|null} config.turnApiUrl
   * @param {number} config.turnRefreshInterval
   * @param {number} config.dcMaxMessageSize
   * @param {number} config.answerTimeout
   */
  constructor({ socketId, apiKey, turnApiUrl, turnRefreshInterval, dcMaxMessageSize, answerTimeout }) {
    super();
    this._socketId = socketId;
    this._apiKey = apiKey;
    this._turnApiUrl = turnApiUrl;
    this._turnRefreshInterval = turnRefreshInterval;
    this._dcMaxMessageSize = dcMaxMessageSize;
    this._answerTimeout = answerTimeout;

    this._pc = null;
    this._dc = null;
    this._iceServers = DEFAULT_ICE;
    this._refreshTimer = null;
    this._remoteSet = false;
    this._pendingCandidates = [];
  }

  get type() { return "dc"; }
  isReady() { return Boolean(this._dc); }

  // WS events not sent via WebRTC — no-op (WsProtocol handles these)
  emit(_event, _data) {}

  /** Send binary chunks via DataChannel */
  sendBinary(chunks) {
    if (!this._dc) return false;
    for (const chunk of chunks) {
      try {
        if (chunk.length <= this._dcMaxMessageSize) this._dc.sendMessageBinary(chunk);
      } catch (err) {
        console.error("[WebRtcProtocol] sendBinary error:", err.message);
        return false;
      }
    }
    return true;
  }

  /** Initialize ICE servers — fetch TURN if apiKey provided, then schedule refresh */
  async init() {
    if (this._apiKey && this._turnApiUrl) {
      await this._refreshTurn();
    }
  }

  /** Handle WebRTC signaling events from a socket */
  setupSignaling(socket) {
    socket.on("webrtc:offer", async ({ sdp }) => {
      try {
        this._createPeer();
        const answerSdp = await this._processOffer(sdp, socket);
        socket.emit("webrtc:answer", { sdp: answerSdp });
      } catch (err) {
        console.error("[WebRtcProtocol] offer error:", err.message);
        socket.emit("webrtc:error", { message: err.message });
      }
    });

    socket.on("webrtc:ice-candidate", ({ candidate, mid }) => {
      // Buffer until remote description is set, else libdatachannel rejects
      if (!this._remoteSet || !this._pc) {
        this._pendingCandidates.push({ candidate, mid: mid || "0" });
        return;
      }
      try {
        this._pc.addRemoteCandidate(candidate, mid || "0");
      } catch (err) {
        console.error("[WebRtcProtocol] addRemoteCandidate error:", err.message);
      }
    });
  }

  close() {
    clearTimeout(this._refreshTimer);
    try { this._pc?.close(); } catch {}
    this._pc = null;
    this._dc = null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _createPeer() {
    try { this._pc?.close(); } catch {}
    this._pc = null;
    this._dc = null;
    this._remoteSet = false;
    this._pendingCandidates = [];

    const pc = new PeerConnection(`peer-${this._socketId}`, { iceServers: this._iceServers });
    pc.onDataChannel((dc) => {
      dc.onOpen(() => { this._dc = dc; });
      dc.onClosed(() => { this._dc = null; });
      dc.onError((err) => console.error(`[WebRtcProtocol] DC error [${this._socketId.slice(0, 6)}]:`, err));
    });
    this._pc = pc;
  }

  _processOffer(sdp, socket) {
    return new Promise((resolve, reject) => {
      this._pc.onLocalDescription((answerSdp, type) => {
        if (type === "answer") resolve(answerSdp);
      });
      this._pc.onLocalCandidate((candidate, mid) => {
        if (candidate) socket.emit("webrtc:ice-candidate", { candidate, mid });
      });
      try {
        this._pc.setRemoteDescription(sdp, "offer");
        this._remoteSet = true;
        // Drain buffered candidates after remote description is set
        for (const { candidate, mid } of this._pendingCandidates) {
          try { this._pc.addRemoteCandidate(candidate, mid); } catch (err) {
            console.error("[WebRtcProtocol] addRemoteCandidate (drain) error:", err.message);
          }
        }
        this._pendingCandidates = [];
        this._pc.setLocalDescription();
      } catch (err) {
        reject(err);
      }
      setTimeout(() => reject(new Error("Answer timeout")), this._answerTimeout);
    });
  }

  async _refreshTurn() {
    const servers = await fetchTurnIceServers(this._turnApiUrl, this._apiKey);
    if (servers?.length) {
      this._iceServers = servers;
      if (REMOTE_CONFIG.logging?.webrtc) console.log(`[WebRtcProtocol] TURN credentials loaded (${servers.length} servers)`);
    }
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this._refreshTurn(), this._turnRefreshInterval);
  }
}
