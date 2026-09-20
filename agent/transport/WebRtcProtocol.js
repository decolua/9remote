import { loadNative } from "./nativeSelfHeal.js";
import { BaseProtocol } from "./BaseProtocol.js";
import { encode, decode, decodeFrame, encodeFragments, createReassembler } from "./codec.js";
import { ADAPTER_STATE, CHANNELS, CONTROL_RTC_MAX_BYTES, FILE_TRANSFER, RTC_HEARTBEAT_INTERVAL_MS, RTC_HEARTBEAT_TIMEOUT_MS } from "../lib/transportConstants.js";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import { resolveCandidate } from "../lib/mdnsResolver.js";
import { createLogger } from "../lib/logger.js";
import { getHostPublicKeyB64, getHostX25519PublicKeyB64, signSdp } from "../lib/hostKey.js";

const logger = createLogger("webrtc");

// Lazy-load node-datachannel with self-heal if install scripts were blocked.
let _nodeDataChannel = null;
function nodeDataChannel() {
  if (!_nodeDataChannel) _nodeDataChannel = loadNative("node-datachannel");
  return _nodeDataChannel;
}

// Test-only injection point — avoids loading the .node binary in unit tests.
export const __setNodeDataChannelForTest = (m) => { _nodeDataChannel = m; };

// STUN cluster across operators for gather redundancy.
const DEFAULT_ICE = [
  { hostname: "stun.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun1.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun2.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun3.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun4.l.google.com", port: 19302, type: "Stun" },
  { hostname: "global.stun.twilio.com", port: 3478, type: "Stun" },
  { hostname: "stun.cloudflare.com", port: 3478, type: "Stun" }
];

// Suppress repeated TURN fetch errors on fallback to STUN-only.
let _lastTurnError = "";
// 23h TURN credentials cache across instances with 3s timeout fallback to STUN.
let _cachedTurnServers = null;
let _cachedTurnExpiresAt = 0;
const TURN_CACHE_TTL_MS = 23 * 60 * 60 * 1000;
const TURN_FETCH_TIMEOUT_MS = 3000;

async function fetchTurnIceServers(turnApiUrl, apiKey) {
  if (_cachedTurnServers && Date.now() < _cachedTurnExpiresAt) {
    return _cachedTurnServers;
  }
  try {
    const resp = await fetch(turnApiUrl, {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(TURN_FETCH_TIMEOUT_MS)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { iceServers } = await resp.json();
    _lastTurnError = ""; // reset on success
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
    _cachedTurnServers = result;
    _cachedTurnExpiresAt = Date.now() + TURN_CACHE_TTL_MS;
    return result;
  } catch (err) {
    if (_lastTurnError !== err.message) {
      _lastTurnError = err.message;
      console.warn(`[WebRtcProtocol] TURN fetch failed (${err.message}) — using STUN-only fallback. Will retry on next connection.`);
    }
    return null;
  }
}

// WebRtcProtocol: server adapter handling control, binary, and file DataChannels.
export class WebRtcProtocol extends BaseProtocol {
  static id = "rtc";
  static capabilities = { control: true, binary: true, file: true, signaling: "external" };
  static priority = { control: 50, binary: 100, file: 100 };

  constructor() {
    super();
    this._pc = null;
    this._dcControl = null;
    this._dcBinary = null;
    this._dcFile = null;
    this._iceServers = DEFAULT_ICE;
    this._refreshTimer = null;
    this._remoteSet = false;
    this._pendingCandidates = [];
    this._signaling = null;
    this._iceGraceTimer = null;
    this._answerTimer = null;
    this._hbTimer = null;
    this._hbLastPong = 0;
    this._peerHb = false;   // peer announced caps.hb — only then may we ping it
    this._peerEnv2 = false; // peer announced caps.env2 — send the binary frame form
    this._peerFragCtl = false; // peer announced caps.fragCtl — it reassembles slices
    this._v2RxSeen = false; // first decoded v2 frame (one-shot diagnostic)
    this._fragSeq = 0;      // ids for sliced control messages
    this._reassemble = createReassembler();
    this._closed = false;
    this.typeDetail = "dc-stun";
    this._turnPromise = null;
  }

  getPriority(channel) {
    // Demote TURN relay below free carriers (Tunnel WS) to eliminate bandwidth cost
    if (this.typeDetail === "dc-turn") return 5;
    return 150;
  }

  async connect(ctx) {
    this._ctx = ctx;
    this._setState(ADAPTER_STATE.connecting);

    const rtcCfg = ctx.profile?.rtc || {};
    // Attach signaling handler immediately so early offers are not dropped.
    this._signaling = ctx.signaling;
    this._signaling?.on?.((msg) => this._handleSignal(msg, rtcCfg));

    if (rtcCfg.enableTurn && ctx.auth?.apiKey && rtcCfg.turnApiUrl) {
      this._turnPromise = this._refreshTurn(rtcCfg);
    }
  }

  disconnect() {
    this._closed = true; // stops an in-flight TURN refresh from re-arming
    clearTimeout(this._refreshTimer);
    this._signaling?.off?.();
    this._signaling = null;
    this._cleanupPeer();
    this._setState(ADAPTER_STATE.closed);
  }

  send(channel, payload) {
    if (channel === CHANNELS.control) {
      if (!this._dcControl) return false;
      const env = { event: payload.event, args: payload.args || [], ackId: payload.ackId || null };
      // Send v2 binary frames if peer supports env2, otherwise fallback to v1 text.
      if (this._peerEnv2) {
        if (!this._sendFramed(env)) return false;
        if (!this._v2Announced) {
          this._v2Announced = true;
          logger.info("[env2] agent→client control now SENT as v2 binary frames");
        }
        return true;
      }
      try {
        this._dcControl.sendMessage(encode(env));
        return true;
      } catch (err) {
        return false;
      }
    }
    if (channel === CHANNELS.binary) {
      if (!this._dcBinary) return false;
      try {
        const chunk = Array.isArray(payload) ? payload[0] : payload;
        // Backpressure: return false so caller retries remaining tiles next frame.
        if (this._dcBinary.bufferedAmount() > REMOTE_CONFIG.webrtc.dcBufferThreshold) return false;
        return this._dcBinary.sendMessageBinary(chunk);
      } catch (err) {
        logger.error(`send binary failed: ${err.message}`);
        return false;
      }
    }
    if (channel === CHANNELS.file) {
      if (!this._dcFile) return false;
      try {
        const raw = Array.isArray(payload) ? payload[0] : payload;
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (this._dcFile.bufferedAmount() > FILE_TRANSFER.dcBufferThreshold) return false;
        return this._dcFile.sendMessageBinary(chunk);
      } catch (err) {
        logger.error(`send file failed: ${err.message}`);
        return false;
      }
    }
    return false;
  }

  // ─── Signaling ─────────────────────────────────────────────────────────────

  async _handleSignal(msg, rtcCfg) {
    if (msg.type === "offer") {
      if (this._turnPromise) {
        try { await this._turnPromise; } catch {}
      }
      this._processOffer(msg.sdp, rtcCfg);
    } else if (msg.type === "ice") {
      if (!this._remoteSet || !this._pc) {
        this._pendingCandidates.push({ candidate: msg.candidate, mid: msg.mid || "0" });
        return;
      }
      this._addRemoteCandidate(msg.candidate, msg.mid || "0");
    } else if (msg.type === "error") {
      logger.warn(`remote signaling error: ${msg.message || "unknown"}`);
    }
  }

  // Resolve .local mDNS hostnames to IP before adding (browser hides LAN IP)
  async _addRemoteCandidate(candidate, mid) {
    try {
      // Empty candidate marks end-of-candidates.
      if (!candidate) { this._pc?.addRemoteCandidate("", mid); return; }
      const resolved = await resolveCandidate(candidate);
      if (!resolved || !this._pc) return;
      this._pc.addRemoteCandidate(resolved, mid);
    } catch (err) { logger.error(`addRemoteCandidate: ${err.message}`); }
  }

  _createPeer(rtcCfg) {
    if (this._pc) logger.warn(`peer recreate while live (state=${this._state}) — reconnect race`);
    try { this._pc?.close(); } catch {}
    this._pc = null;
    this._dcControl = null;
    this._dcBinary = null;
    this._dcFile = null;
    this._remoteSet = false;
    this._lastMid = null;
    this.typeDetail = "dc-stun";
    // Do not clear _pendingCandidates here; flushed after setRemoteDescription.
    if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }
    if (this._answerTimer) { clearTimeout(this._answerTimer); this._answerTimer = null; }

    const socketId = this._ctx?.auth?.socketId || "anon";
    const { PeerConnection } = nodeDataChannel();
    const pc = new PeerConnection(`peer-${socketId}`, { iceServers: this._iceServers });

    // ICE lifecycle — close on real death; grace-debounce transient "disconnected"
    this._pcState = "new";
    pc.onStateChange((state) => {
      const prev = this._pcState;
      this._pcState = state;
      logger.debug(`peer ${prev}→${state}`);
      if (state === "failed" || state === "closed") {
        if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }
        this._setState(ADAPTER_STATE.closed);
      } else if (state === "disconnected") {
        if (this._iceGraceTimer) return;
        logger.debug(`peer disconnected → grace ${REMOTE_CONFIG.webrtc.iceDisconnectGraceMs}ms before closing`);
        this._iceGraceTimer = setTimeout(() => {
          this._iceGraceTimer = null;
          if (this._pcState === "connected") { logger.debug("peer recovered inside grace"); return; }
          logger.debug(`peer still ${this._pcState} after grace → closed`);
          this._setState(ADAPTER_STATE.closed);
        }, REMOTE_CONFIG.webrtc.iceDisconnectGraceMs);
      } else if (state === "connected") {
        if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }
      }
    });

    pc.onDataChannel((dc) => {
      const label = dc.getLabel?.() || "";
      const setOpen = () => {
        if (label === "control") { this._dcControl = dc; if (this._peerHb) this._startHeartbeat(dc); }
        else if (label === "binary") this._dcBinary = dc;
        else if (label === "file") this._dcFile = dc;
        // Adapter is open once control and binary channels are established.
        if (this._dcControl && this._dcBinary) this._setState(ADAPTER_STATE.open);
      };
      dc.onOpen(() => { logger.debug(`DC[${label}] open`); setOpen(); });
      dc.onClosed(() => {
        logger.debug(`DC[${label}] closed`);
        if (label === "control") { this._stopHeartbeat(); this._dcControl = null; }
        if (label === "binary") this._dcBinary = null;
        if (label === "file") this._dcFile = null;
        if (!this._dcControl && !this._dcBinary) this._setState(ADAPTER_STATE.closed);
      });
      dc.onError((err) => logger.error(`DC[${label}] error: ${err?.message || err}`));
      dc.onMessage((data) => {
        if (label === "file") {
          this._emit("binary", { channel: "file", buffer: data, source: "rtc" });
          return;
        }
        if (label !== "control") return;
        let parsed;
        try {
          let decoded;
          if (typeof data === "string") decoded = decode(data);
          else {
            decoded = decodeFrame(data);
            if (!this._v2RxSeen) {
              this._v2RxSeen = true;
              logger.info("[env2] first v2 binary frame DECODED from client (mutual upgrade confirmed)");
            }
          }
          // Reassemble fragmented control frames before dispatch.
          parsed = this._reassemble.push(decoded);
        }
        catch (err) { logger.error(`control parse: ${err.message}`); return; }
        if (!parsed) return;
        if (parsed.event === "__pong") { this._hbLastPong = Date.now(); return; }
        if (parsed.event === "rtc:linkType") {
          this.typeDetail = parsed.args?.[0] || "dc-stun";
          logger.info(`[rtc] linkType from client: ${this.typeDetail}`);
          return;
        }
        try { this._emit("message", { event: parsed.event, data: parsed, source: "rtc" }); }
        catch (err) { logger.error(`handler error event=${parsed.event}: ${err.message}`); }
      });
    });

    this._pc = pc;
  }

  _processOffer(sdp, rtcCfg) {
    this._createPeer(rtcCfg);
    let settled = false;
    const clearAnswerTimer = () => {
      if (this._answerTimer) { clearTimeout(this._answerTimer); this._answerTimer = null; }
    };
    return new Promise((resolve, reject) => {
      this._pc.onLocalDescription((answerSdp, type) => {
        if (type !== "answer" || settled) return;
        settled = true;
        clearAnswerTimer();
        // Sign SDP answer with host key to allow client-side peer verification.
        this._signaling?.send?.({
          type: "answer",
          sdp: answerSdp,
          pub: getHostPublicKeyB64(),
          xpub: getHostX25519PublicKeyB64(),
          sig: signSdp(answerSdp)
        });
        resolve();
      });
      this._pc.onLocalCandidate((candidate, mid) => {
        this._lastMid = mid;
        if (candidate) this._signaling?.send?.({ type: "ice", candidate, mid });
      });
      // Signal end-of-candidates on complete gathering state change.
      this._pc.onGatheringStateChange?.((state) => {
        if (state !== "complete") return;
        this._signaling?.send?.({ type: "ice", candidate: "", mid: this._lastMid || "0" });
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
        if (!settled) { settled = true; clearAnswerTimer(); }
        this._signaling?.send?.({ type: "error", message: err.message });
        reject(err);
        return;
      }
      const timeout = rtcCfg?.answerTimeout || 10000;
      this._answerTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._answerTimer = null;
        logger.warn(`Answer timeout (no local description within ${timeout}ms)`);
        reject(new Error("Answer timeout"));
      }, timeout);
    });
  }

  _cleanupPeer() {
    if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }
    if (this._answerTimer) { clearTimeout(this._answerTimer); this._answerTimer = null; }
    this._stopHeartbeat();
    try { this._pc?.close(); } catch {}
    this._pc = null;
    this._dcControl = null;
    this._dcBinary = null;
    this._dcFile = null;
    this.typeDetail = "dc-stun";
    // Reset reassembler so stale fragments do not corrupt next peer's messages.
    this._reassemble = createReassembler();
  }

  // Sets peer capabilities (heartbeat, env2, control fragmentation).
  setPeerCaps(caps) {
    this._peerHb = !!caps?.hb;
    this._peerEnv2 = !!caps?.env2;
    this._peerFragCtl = !!caps?.fragCtl;
    if (this._peerHb && this._dcControl && !this._hbTimer) this._startHeartbeat(this._dcControl);
  }

  get maxControlBytes() {
    try { return this._dcControl?.maxMessageSize() || CONTROL_RTC_MAX_BYTES; }
    catch { return CONTROL_RTC_MAX_BYTES; }
  }

  // Sends control envelope, fragmenting into SCTP-sized frames if supported.
  _sendFramed(env) {
    const max = this._peerFragCtl ? this.maxControlBytes : Infinity;
    const frames = encodeFragments(env, max, ++this._fragSeq);
    if (!frames) return false;
    try {
      for (const frame of frames) {
        if (!this._dcControl.sendMessageBinary(frame)) return false;
      }
      return true;
    } catch (err) {
      logger.debug(`control send refused: ${err.message}`);
      return false;
    }
  }

  // Heartbeat pings control DC and closes stalled peer if no pong received.
  _startHeartbeat(dc) {
    this._stopHeartbeat();
    this._hbLastPong = Date.now();
    this._hbTimer = setInterval(() => {
      if (!this._dcControl) { this._stopHeartbeat(); return; }
      const silent = Date.now() - this._hbLastPong;
      if (silent > RTC_HEARTBEAT_TIMEOUT_MS) {
        logger.warn(`heartbeat: no pong for ${silent}ms → closing stalled peer`);
        this._stopHeartbeat();
        try { this._pc?.close(); } catch {}
        return;
      }
      try { dc.sendMessage(encode({ event: "__ping", args: [Date.now()] })); }
      catch (err) { logger.debug(`heartbeat send failed: ${err.message}`); }
    }, RTC_HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }

  async _refreshTurn(rtcCfg) {
    const servers = await fetchTurnIceServers(rtcCfg.turnApiUrl, this._ctx.auth.apiKey);
    if (this._closed) return;
    if (servers?.length) {
      this._iceServers = servers;
      if (REMOTE_CONFIG.logging?.webrtc) console.log(`[WebRtcProtocol] TURN credentials loaded (${servers.length} servers)`);
    }
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this._refreshTurn(rtcCfg), rtcCfg.turnRefreshInterval);
  }
}
