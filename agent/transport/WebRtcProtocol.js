import nodeDataChannel from "node-datachannel";
import { BaseProtocol } from "./BaseProtocol.js";
import { encode, decode } from "./codec.js";
import { ADAPTER_STATE, CHANNELS } from "../lib/transportConstants.js";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import { resolveCandidate } from "../lib/mdnsResolver.js";

const { PeerConnection } = nodeDataChannel;

// STUN cluster — benchmarked from VN: Google ~150ms, Twilio ~144ms, Cloudflare ~813ms
const DEFAULT_ICE = [
  { hostname: "stun.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun1.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun2.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun3.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun4.l.google.com", port: 19302, type: "Stun" },
  { hostname: "global.stun.twilio.com", port: 3478, type: "Stun" },
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
 * WebRtcProtocol — server adapter. Two DCs (control/binary) created by client side;
 * server reacts via onDataChannel. Signaling routed via ProtocolManager.
 */
export class WebRtcProtocol extends BaseProtocol {
  static id = "rtc";
  static capabilities = { control: true, binary: true, signaling: "external" };
  static priority = { control: 50, binary: 100 };

  constructor() {
    super();
    this._pc = null;
    this._dcControl = null;
    this._dcBinary = null;
    this._iceServers = DEFAULT_ICE;
    this._refreshTimer = null;
    this._remoteSet = false;
    this._pendingCandidates = [];
    this._signaling = null;
    this._iceGraceTimer = null;
  }

  /**
   * @param {object} ctx
   * @param {object} ctx.auth        — { apiKey, socketId }
   * @param {object} ctx.profile     — { rtc: { enableTurn, turnApiUrl, turnRefreshInterval, dcMaxMessageSize, answerTimeout } }
   * @param {object} ctx.signaling   — { send(msg), on(handler), off() }
   */
  async connect(ctx) {
    this._ctx = ctx;
    this._setState(ADAPTER_STATE.connecting);

    const rtcCfg = ctx.profile?.rtc || {};
    if (rtcCfg.enableTurn && ctx.auth?.apiKey && rtcCfg.turnApiUrl) {
      await this._refreshTurn(rtcCfg);
    }

    this._signaling = ctx.signaling;
    this._signaling?.on?.((msg) => this._handleSignal(msg, rtcCfg));
  }

  disconnect() {
    clearTimeout(this._refreshTimer);
    this._signaling?.off?.();
    this._signaling = null;
    this._cleanupPeer();
    this._setState(ADAPTER_STATE.closed);
  }

  send(channel, payload) {
    if (channel === CHANNELS.control) {
      if (!this._dcControl) return false;
      try {
        this._dcControl.sendMessage(encode({ event: payload.event, args: payload.args || [], ackId: payload.ackId || null }));
        return true;
      } catch (err) {
        console.error("[WebRtcProtocol] send control:", err.message);
        return false;
      }
    }
    if (channel === CHANNELS.binary) {
      if (!this._dcBinary) return false;
      try {
        // payload may be array of chunks or single Buffer
        const chunks = Array.isArray(payload) ? payload : [payload];
        const max = this._ctx.profile?.rtc?.dcMaxMessageSize ?? 65536;
        const bufThreshold = REMOTE_CONFIG.webrtc.dcBufferThreshold;
        for (const chunk of chunks) {
          // Backpressure — drop frame if SCTP send queue is congested
          if (this._dcBinary.bufferedAmount() > bufThreshold) return true;
          if (chunk.length <= max) this._dcBinary.sendMessageBinary(chunk);
        }
        return true;
      } catch (err) {
        console.error("[WebRtcProtocol] send binary:", err.message);
        return false;
      }
    }
    return false;
  }

  // ─── Signaling ─────────────────────────────────────────────────────────────

  _handleSignal(msg, rtcCfg) {
    if (msg.type === "offer") {
      this._processOffer(msg.sdp, rtcCfg);
    } else if (msg.type === "ice") {
      if (!this._remoteSet || !this._pc) {
        this._pendingCandidates.push({ candidate: msg.candidate, mid: msg.mid || "0" });
        return;
      }
      this._addRemoteCandidate(msg.candidate, msg.mid || "0");
    }
  }

  // Resolve .local mDNS hostnames to IP before adding (browser hides LAN IP)
  async _addRemoteCandidate(candidate, mid) {
    try {
      const resolved = await resolveCandidate(candidate);
      if (!resolved || !this._pc) return;
      this._pc.addRemoteCandidate(resolved, mid);
    } catch (err) { console.error("[WebRtcProtocol] addRemoteCandidate:", err.message); }
  }

  _createPeer(rtcCfg) {
    try { this._pc?.close(); } catch {}
    this._pc = null;
    this._dcControl = null;
    this._dcBinary = null;
    this._remoteSet = false;
    this._pendingCandidates = [];
    if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }

    const socketId = this._ctx?.auth?.socketId || "anon";
    const pc = new PeerConnection(`peer-${socketId}`, { iceServers: this._iceServers });

    // ICE lifecycle — close on real death; grace-debounce transient "disconnected"
    this._pcState = "new";
    pc.onStateChange((state) => {
      this._pcState = state;
      if (state === "failed" || state === "closed") {
        if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }
        this._setState(ADAPTER_STATE.closed);
      } else if (state === "disconnected") {
        if (this._iceGraceTimer) return;
        this._iceGraceTimer = setTimeout(() => {
          this._iceGraceTimer = null;
          if (this._pcState !== "connected") this._setState(ADAPTER_STATE.closed);
        }, REMOTE_CONFIG.webrtc.iceDisconnectGraceMs);
      } else if (state === "connected") {
        if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }
      }
    });

    pc.onDataChannel((dc) => {
      const label = dc.getLabel?.() || "";
      const setOpen = () => {
        if (label === "control") this._dcControl = dc;
        else if (label === "binary") this._dcBinary = dc;
        if (this._dcControl && this._dcBinary) this._setState(ADAPTER_STATE.open);
      };
      dc.onOpen(setOpen);
      dc.onClosed(() => {
        if (label === "control") this._dcControl = null;
        if (label === "binary") this._dcBinary = null;
        if (!this._dcControl && !this._dcBinary) this._setState(ADAPTER_STATE.closed);
      });
      dc.onError((err) => console.error(`[WebRtcProtocol] DC[${label}] error:`, err));
      dc.onMessage((data) => {
        if (label !== "control") return;
        let parsed;
        try { parsed = decode(data); }
        catch (err) { console.error("[WebRtcProtocol] control parse:", err.message); return; }
        try { this._emit("message", { event: parsed.event, data: parsed, source: "rtc" }); }
        catch (err) { console.error(`[WebRtcProtocol] handler error event=${parsed.event}:`, err.message); }
      });
    });

    this._pc = pc;
  }

  _processOffer(sdp, rtcCfg) {
    this._createPeer(rtcCfg);
    return new Promise((resolve, reject) => {
      this._pc.onLocalDescription((answerSdp, type) => {
        if (type === "answer") {
          this._signaling?.send?.({ type: "answer", sdp: answerSdp });
          resolve();
        }
      });
      this._pc.onLocalCandidate((candidate, mid) => {
        if (candidate) this._signaling?.send?.({ type: "ice", candidate, mid });
      });
      try {
        this._pc.setRemoteDescription(sdp, "offer");
        this._remoteSet = true;
        for (const { candidate, mid } of this._pendingCandidates) {
          this._addRemoteCandidate(candidate, mid);
        }
        this._pendingCandidates = [];
        this._pc.setLocalDescription();
      } catch (err) {
        this._signaling?.send?.({ type: "error", message: err.message });
        reject(err);
      }
      const timeout = rtcCfg?.answerTimeout || 10000;
      setTimeout(() => reject(new Error("Answer timeout")), timeout);
    });
  }

  _cleanupPeer() {
    if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }
    try { this._pc?.close(); } catch {}
    this._pc = null;
    this._dcControl = null;
    this._dcBinary = null;
  }

  async _refreshTurn(rtcCfg) {
    const servers = await fetchTurnIceServers(rtcCfg.turnApiUrl, this._ctx.auth.apiKey);
    if (servers?.length) {
      this._iceServers = servers;
      if (REMOTE_CONFIG.logging?.webrtc) console.log(`[WebRtcProtocol] TURN credentials loaded (${servers.length} servers)`);
    }
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this._refreshTurn(rtcCfg), rtcCfg.turnRefreshInterval);
  }
}
