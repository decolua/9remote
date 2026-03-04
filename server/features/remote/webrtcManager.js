import nodeDataChannel from "node-datachannel";
import { remoteConfig } from "./config.js";

const { PeerConnection } = nodeDataChannel;
const { turnApiUrl, turnRefreshInterval, dcMaxMessageSize, answerTimeout } = remoteConfig.webrtc;

// Default STUN-only fallback (used until TURN creds are fetched)
const DEFAULT_ICE = [
  { hostname: "stun.cloudflare.com", port: 3478, type: "Stun" }
];

/**
 * Fetch TURN credentials from worker, return node-datachannel ICE server format.
 * Requires a valid apiKey to authenticate with the worker endpoint.
 */
async function fetchTurnIceServers(apiKey) {
  try {
    const resp = await fetch(turnApiUrl, {
      headers: { "X-API-Key": apiKey }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { iceServers } = await resp.json();

    // Convert browser RTCIceServer format → node-datachannel format
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
          result.push({
            hostname: host,
            port,
            type: isTls ? "Tls" : "Turn",
            relayType: transport,
            username: srv.username,
            password: srv.credential
          });
        }
      }
    }
    return result;
  } catch (err) {
    console.error("[WebRTC] Failed to fetch TURN credentials:", err.message);
    return null;
  }
}

/**
 * Manages one WebRTC PeerConnection per remote client.
 * Handles signaling (offer/answer/ICE) and exposes a DataChannel
 * for sending binary tile data directly to the browser peer.
 */
export class WebRTCManager {
  constructor() {
    // Map<socketId, { pc, dc }>
    this.peers = new Map();
    this.iceServers = DEFAULT_ICE;
    this.apiKey = null;
    this._refreshTimer = null;
  }

  /**
   * Initialize with apiKey — fetches TURN credentials and schedules refresh.
   */
  async init(apiKey) {
    this.apiKey = apiKey;
    await this._refreshTurnCredentials();
  }

  async _refreshTurnCredentials() {
    if (!this.apiKey) return;
    const servers = await fetchTurnIceServers(this.apiKey);
    if (servers?.length) {
      this.iceServers = servers;
      console.log(`[WebRTC] TURN credentials loaded (${servers.length} servers)`);
    }
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(
      () => this._refreshTurnCredentials(),
      turnRefreshInterval
    );
  }

  /**
   * Create server-side PeerConnection for a client socket.
   */
  createPeer(socketId) {
    this.closePeer(socketId);

    const pc = new PeerConnection(`peer-${socketId}`, {
      iceServers: this.iceServers
    });

    pc.onDataChannel((dc) => {
      dc.onOpen(() => {
        const entry = this.peers.get(socketId);
        if (entry) entry.dc = dc;
        console.log(`[WebRTC] DataChannel open [${socketId.slice(0, 6)}]`);
      });
      dc.onClosed(() => {
        const entry = this.peers.get(socketId);
        if (entry) entry.dc = null;
      });
      dc.onError((err) => console.error(`[WebRTC] DC error [${socketId.slice(0, 6)}]:`, err));
    });

    this.peers.set(socketId, { pc, dc: null });
    return { pc };
  }

  /**
   * Process SDP offer from browser, generate and return answer SDP.
   */
  async processOffer(socketId, sdp) {
    const entry = this.peers.get(socketId);
    if (!entry) throw new Error("No peer for socket " + socketId);

    const { pc } = entry;

    return new Promise((resolve, reject) => {
      pc.onLocalDescription((answerSdp, type) => {
        if (type === "answer") resolve(answerSdp);
      });

      try {
        pc.setRemoteDescription(sdp, "offer");
        pc.setLocalDescription();
      } catch (err) {
        reject(err);
      }

      setTimeout(() => reject(new Error("Answer timeout")), answerTimeout);
    });
  }

  /**
   * Add ICE candidate from browser.
   */
  addIceCandidate(socketId, candidate, mid) {
    const entry = this.peers.get(socketId);
    if (!entry) return;
    try {
      entry.pc.addRemoteCandidate(candidate, mid);
    } catch (err) {
      console.error("[WebRTC] addRemoteCandidate error:", err.message);
    }
  }

  /**
   * Send binary tile buffer via DataChannel if open.
   * Returns true if sent, false if DC not ready (caller should fallback to WS).
   */
  sendTile(socketId, buffer) {
    const entry = this.peers.get(socketId);
    if (!entry?.dc) return false;
    try {
      if (buffer.length > dcMaxMessageSize) {
        console.warn(`[WebRTC] tile too large (${buffer.length}B), skipping DC → WS fallback`);
        return false;
      }
      entry.dc.sendMessageBinary(buffer);
      return true;
    } catch (err) {
      console.error(`[WebRTC] sendTile error [${socketId.slice(0, 6)}]:`, err.message);
      return false;
    }
  }

  /**
   * Check if DataChannel is open for a client.
   */
  isReady(socketId) {
    const entry = this.peers.get(socketId);
    return Boolean(entry?.dc);
  }

  closePeer(socketId) {
    const entry = this.peers.get(socketId);
    if (!entry) return;
    try { entry.pc.close(); } catch {}
    this.peers.delete(socketId);
  }

  closeAll() {
    clearTimeout(this._refreshTimer);
    for (const socketId of this.peers.keys()) this.closePeer(socketId);
  }
}
