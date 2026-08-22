import { loadNative } from "./nativeSelfHeal.js";
import { BaseProtocol } from "./BaseProtocol.js";
import { encode, decode } from "./codec.js";
import { ADAPTER_STATE, CHANNELS, FILE_TRANSFER } from "../lib/transportConstants.js";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import { resolveCandidate } from "../lib/mdnsResolver.js";
import { createLogger } from "../lib/logger.js";
import { getHostPublicKeyB64, signSdp } from "../lib/hostKey.js";

const logger = createLogger("webrtc");

// Lazy load: node-datachannel's native binary may be missing if install scripts
// were blocked (e.g. Garner/npm fork). loadNative self-heals via prebuild-install.
let _nodeDataChannel = null;
function nodeDataChannel() {
  if (!_nodeDataChannel) _nodeDataChannel = loadNative("node-datachannel");
  return _nodeDataChannel;
}

// Test-only injection point — avoids loading the .node binary in unit tests.
export const __setNodeDataChannelForTest = (m) => { _nodeDataChannel = m; };

// STUN cluster — benchmarked from VN: Google ~150ms, Twilio ~144ms, Cloudflare ~813ms
// Original cluster, restored after the trim turned out to buy nothing: libjuice
// gathers from ONE socket (all candidates share a port), so server count does
// not change the NAT mapping count — only gather redundancy across operators.
// The ~2s answer latency the trim once addressed is absorbed by the client's
// separate ICE window.
const DEFAULT_ICE = [
  { hostname: "stun.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun1.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun2.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun3.l.google.com", port: 19302, type: "Stun" },
  { hostname: "stun4.l.google.com", port: 19302, type: "Stun" },
  { hostname: "global.stun.twilio.com", port: 3478, type: "Stun" },
  { hostname: "stun.cloudflare.com", port: 3478, type: "Stun" }
];

// Suppress repeated TURN fetch errors — endpoint fails non-fatally (STUN-only fallback),
// but each new connection retried the fetch, spamming identical errors.
let _lastTurnError = "";
// The first peer waits on this fetch, so an unreachable endpoint must not stall
// the connection — a 502 was observed taking ~14s. STUN-only is the fallback.
const TURN_FETCH_TIMEOUT_MS = 3000;

async function fetchTurnIceServers(turnApiUrl, apiKey) {
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
    return result;
  } catch (err) {
    // Non-fatal: STUN-only fallback. Log once per distinct error to avoid spam.
    if (_lastTurnError !== err.message) {
      _lastTurnError = err.message;
      console.warn(`[WebRtcProtocol] TURN fetch failed (${err.message}) — using STUN-only fallback. Will retry on next connection.`);
    }
    return null;
  }
}

/**
 * WebRtcProtocol — server adapter. Two DCs (control/binary) created by client side;
 * server reacts via onDataChannel. Signaling routed via ProtocolManager.
 */
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
    this._closed = false;
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
    // Handler first: the client is usually already offering by the time we get
    // here, and an offer that finds no handler is dropped. TURN is opt-in and
    // off by default (STUN + tunnel only), so nothing is awaited on this path.
    this._signaling = ctx.signaling;
    this._signaling?.on?.((msg) => this._handleSignal(msg, rtcCfg));

    if (rtcCfg.enableTurn && ctx.auth?.apiKey && rtcCfg.turnApiUrl) {
      await this._refreshTurn(rtcCfg);
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
      try {
        this._dcControl.sendMessage(encode({ event: payload.event, args: payload.args || [], ackId: payload.ackId || null }));
        return true;
      } catch (err) {
        // Oversize/dead-channel errors are expected — ProtocolManager falls back to WS.
        return false;
      }
    }
    if (channel === CHANNELS.binary) {
      if (!this._dcBinary) return false;
      try {
        // Single pre-sized chunk (Buffer) — PM splits by dcMaxMessageSize.
        const chunk = Array.isArray(payload) ? payload[0] : payload;
        // Backpressure — return false so PM stops and retries remaining tiles next frame
        if (this._dcBinary.bufferedAmount() > REMOTE_CONFIG.webrtc.dcBufferThreshold) return false;
        // sendMessageBinary returns false on oversize/negotiated-max violation — treat as drop
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
        // node-datachannel expects Buffer; encodeFileFrame yields Uint8Array.
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        // Generous threshold — file transfer is throughput, not real-time.
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

  _handleSignal(msg, rtcCfg) {
    if (msg.type === "offer") {
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
      const resolved = await resolveCandidate(candidate);
      // TEMP DIAGNOSTIC — see whether the phone's .local candidates resolve;
      // a null here means the agent silently dropped a LAN pair.
      if (!resolved) logger.warn(`TEMP DIAGNOSTIC remote cand DROPPED (mDNS?): ${candidate}`);
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
    // NOTE: do NOT clear _pendingCandidates here — _processOffer flushes them
    // after setRemoteDescription. Wiping them drops early ICE (pre-offer) silently,
    // which stalls ICE during a network-flap storm → Answer timeout pile-up.
    if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }
    if (this._answerTimer) { clearTimeout(this._answerTimer); this._answerTimer = null; }

    const socketId = this._ctx?.auth?.socketId || "anon";
    const { PeerConnection } = nodeDataChannel();
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
        else if (label === "file") this._dcFile = dc;
        // Adapter is "open" once control+binary (tiles) are up; the file DC is a
        // secondary channel that may open slightly later and is optional for state.
        if (this._dcControl && this._dcBinary) this._setState(ADAPTER_STATE.open);
      };
      dc.onOpen(setOpen);
      dc.onClosed(() => {
        if (label === "control") this._dcControl = null;
        if (label === "binary") this._dcBinary = null;
        if (label === "file") this._dcFile = null;
        if (!this._dcControl && !this._dcBinary) this._setState(ADAPTER_STATE.closed);
      });
      dc.onError((err) => logger.error(`DC[${label}] error: ${err?.message || err}`));
      dc.onMessage((data) => {
        // File DC carries raw binary frames (upload chunks from client).
        if (label === "file") {
          this._emit("binary", { channel: "file", buffer: data, source: "rtc" });
          return;
        }
        if (label !== "control") return;
        let parsed;
        try { parsed = decode(data); }
        catch (err) { logger.error(`control parse: ${err.message}`); return; }
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
        // Signed answer — lets the client verify (via the pinned host key) that
        // the relay never swapped the peer. Legacy clients ignore the extras.
        this._signaling?.send?.({
          type: "answer",
          sdp: answerSdp,
          pub: getHostPublicKeyB64(),
          sig: signSdp(answerSdp)
        });
        resolve();
      });
      this._pc.onLocalCandidate((candidate, mid) => {
        // TEMP DIAGNOSTIC — ICE fails with zero connecting pairs on same-LAN;
        // log every gathered candidate to see whether host IPs are present.
        if (candidate) logger.debug(`TEMP DIAGNOSTIC local cand: ${candidate}`);
        if (candidate) this._signaling?.send?.({ type: "ice", candidate, mid });
      });
      try {
        this._pc.setRemoteDescription(sdp, "offer");
        this._remoteSet = true;
        // Flush ICE buffered before the offer arrived (network-flap race).
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
    try { this._pc?.close(); } catch {}
    this._pc = null;
    this._dcControl = null;
    this._dcBinary = null;
    this._dcFile = null;
  }

  async _refreshTurn(rtcCfg) {
    const servers = await fetchTurnIceServers(rtcCfg.turnApiUrl, this._ctx.auth.apiKey);
    // disconnect() may have run while the fetch was in flight — re-arming here
    // would leave a dead adapter polling TURN for the life of the process.
    if (this._closed) return;
    if (servers?.length) {
      this._iceServers = servers;
      if (REMOTE_CONFIG.logging?.webrtc) console.log(`[WebRtcProtocol] TURN credentials loaded (${servers.length} servers)`);
    }
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this._refreshTurn(rtcCfg), rtcCfg.turnRefreshInterval);
  }
}
