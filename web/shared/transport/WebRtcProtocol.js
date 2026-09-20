import { BaseProtocol } from "./BaseProtocol";
import { encode, decode, decodeFrame, encodeFragments, createReassembler } from "./codec";
import { API_ENDPOINTS } from "@/shared/constants/API";
import { ADAPTER_STATE, CHANNELS, CONTROL_RTC_MAX_BYTES, DEAD_PATH_POLL_MS, FILE_TRANSFER, RTC_CONNECT_TIMEOUT_MS, RTC_ICE_TIMEOUT_MS, RTC_HEARTBEAT_INTERVAL_MS, RTC_HEARTBEAT_TIMEOUT_MS } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { getTrust, setTrust, getPendingFp2, takePendingFp2, hostFingerprint, verifySdpSignature } from "./lib/deviceTrust";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

// Shared decoder worker (one instance for all WebRtcProtocol instances)
let _worker = null;
let _workerMsgId = 0;
const _workerPending = new Map();
// Drop pending decode if worker suspended (iOS background) or killed.
const WORKER_DECODE_TIMEOUT_MS = 8000;
// Bound respawn retries when worker fails to load (e.g. CSP).
const MAX_WORKER_RESPAWNS = 3;
let _workerFailures = 0;

const TURN_CACHE_KEY = "9remote_turn_cache";
const TURN_CACHE_TTL_MS = 23 * 60 * 60 * 1000;

async function getCachedTurnServers(turnApiUrl, apiKey) {
  const cacheKey = `${TURN_CACHE_KEY}_${apiKey?.slice(0, 12) || "anon"}`;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(cacheKey) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.expiresAt > Date.now() && Array.isArray(parsed.iceServers) && parsed.iceServers.length) {
        return parsed.iceServers;
      }
    }
  } catch {}

  try {
    const resp = await fetch(turnApiUrl, {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(4000)
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data?.iceServers?.length) {
        try {
          if (typeof localStorage !== "undefined") {
            localStorage.setItem(cacheKey, JSON.stringify({
              iceServers: data.iceServers,
              expiresAt: Date.now() + TURN_CACHE_TTL_MS
            }));
          }
        } catch {}
        return data.iceServers;
      }
    }
  } catch (err) {
    console.warn("[WebRtcProtocol] TURN fetch failed:", err.message);
  }
  return null;
}

function getWorker() {
  if (_worker === false) return null; // previously failed (CSP / unsupported)
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL("../../features/remote/workers/tileDecoder.worker.js", import.meta.url));
  } catch {
    _worker = false;
    return null;
  }
  _worker.onmessage = ({ data: { tiles, timestamp, id, hasBitmap, error } }) => {
    _workerFailures = 0;
    const entry = _workerPending.get(id);
    if (!entry) {
      // Close orphan bitmaps from dropped batches to prevent GPU memory leak.
      if (tiles) for (const t of tiles) t.bitmap?.close?.();
      return;
    }
    clearTimeout(entry.timer);
    _workerPending.delete(id);
    entry.resolve(error ? null : { tiles, timestamp, hasBitmap });
  };
  _worker.onerror = (err) => {
    console.error("[Worker] tileDecoder:", err.message);
    // Reset dead worker so next tile spawns a fresh one.
    resetWorker();
    if (++_workerFailures >= MAX_WORKER_RESPAWNS) _worker = false;
  };
  return _worker;
}

// Drop pending decodes and terminate worker (iOS background recovery).
function resetWorker() {
  if (_worker) { try { _worker.terminate(); } catch {} }
  _worker = null;
  for (const { resolve } of _workerPending.values()) { try { resolve(null); } catch {} }
  _workerPending.clear();
}

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
    this._typeDetail = "dc-stun";
    // NAT classification state for natVerdict.
    this._localCandidateTypes = new Set();
    this._answerApplied = false;
    this._pendingCandidates = [];
    this._iceReachedChecking = false;
    this._everOpened = false;
    this._isLoopback = false;

    this._pendingEmit = null;
    this._flushTimer = null;
    this._latestTileTs = new Map();

    // Detect stalled SCTP when open channel blackholes messages.
    this._hbTimer = null;
    this._hbLastPing = 0;
    this._peerEnv2 = false;
    this._peerFragCtl = false;
    this._v2Announced = false;
    this._v2RxSeen = false;
    this._fragSeq = 0;
    this._reassemble = createReassembler();
    this._lastInboundAt = 0;

    this._signalingHandlers = {};
    this._signaling = null;
    this._useTurn = false;
  }

  get lastInboundAt() { return this._lastInboundAt; }

  getPriority(channel) {
    // Demote TURN relay below free carriers (Tunnel WS) to eliminate bandwidth cost
    if (this._typeDetail === "dc-turn") return 5;
    return 150;
  }

  async connect(ctx) {
    this._ctx = ctx;
    this._cleanupPeer();
    this._peerEpoch = (this._peerEpoch ?? 0) + 1;
    this._localCandidateTypes = new Set();
    this._answerApplied = false;
    this._pendingCandidates = [];
    this._iceReachedChecking = false;
    this._everOpened = false;
    this._isLoopback = false;
    this._typeDetail = "dc-stun";
    this._lastMid = null;
    this._remoteGatheringDone = false;
    this._setState(ADAPTER_STATE.connecting);
    this.connectingSince = Date.now();
    this.connectDeadline = this.connectingSince + RTC_CONNECT_TIMEOUT_MS;
    // Failover to PM retry if offer dropped before agent joined.
    clearTimeout(this._connectTimer);
    this._connectTimer = setTimeout(() => {
      if (this._state === ADAPTER_STATE.open) return;
      debugLog("transport", `[rtc] connect timeout (${RTC_CONNECT_TIMEOUT_MS}ms, state=${this._state}) → close + retry`);
      this._closePeer(`connect-timeout (state=${this._state})`);
    }, RTC_CONNECT_TIMEOUT_MS);

    // Multiple STUN servers provide redundant CGNAT mappings for mobile carriers.
    let iceServers = [
      { urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:stun2.l.google.com:19302",
        "stun:stun3.l.google.com:19302",
        "stun:stun4.l.google.com:19302"
      ] },
      { urls: "stun:global.stun.twilio.com:3478" },
      { urls: "stun:stun.cloudflare.com:3478" }
    ];
    this._useTurn = !!(ctx.useTurn || ctx.profile?.rtc?.enableTurn);
    if (ctx.iceServers?.length) {
      iceServers = ctx.iceServers;
    } else if (this._useTurn) {
      const turnServers = await getCachedTurnServers(API_ENDPOINTS.turnCredentials, ctx.auth?.apiKey);
      if (turnServers?.length) iceServers = turnServers;
    }

    const pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    });
    this._pc = pc;

    const ordered = ctx.profile?.rtc?.dcControl?.ordered ?? true;
    const dcControl = pc.createDataChannel("control", { ordered });
    const dcBinary = pc.createDataChannel("binary", { ordered: false, maxPacketLifeTime: 500 });
    const dcFile = pc.createDataChannel("file", { ordered: true });
    dcBinary.binaryType = "arraybuffer";
    dcControl.binaryType = "arraybuffer";
    dcFile.binaryType = "arraybuffer";
    this._dcControl = dcControl;
    this._dcBinary = dcBinary;
    this._dcFile = dcFile;

    const checkOpen = async () => {
      if (dcControl.readyState !== "open" || dcBinary.readyState !== "open") return;
      let pairInfo = "";
      try {
        const stats = await pc.getStats();
        stats.forEach((s) => {
          if (s.type === "candidate-pair" && s.state === "succeeded") {
            const local = [...stats.values()].find((c) => c.id === s.localCandidateId);
            const remote = [...stats.values()].find((c) => c.id === s.remoteCandidateId);
            if (local?.candidateType === "relay" || remote?.candidateType === "relay") this._typeDetail = "dc-turn";
            const lAddr = local?.address || local?.ip || "";
            const rAddr = remote?.address || remote?.ip || "";
            if (lAddr === "127.0.0.1" || lAddr === "::1" || rAddr === "127.0.0.1" || rAddr === "::1") {
              this._isLoopback = true;
            }
            pairInfo = `local=${local?.candidateType}/${local?.protocol} remote=${remote?.candidateType}/${remote?.protocol}`;
          }
        });
      } catch {}
      this.send(CHANNELS.control, { event: "rtc:linkType", args: [this._typeDetail] });
      debugLog("transport", `[rtc] dc OPEN type=${this._typeDetail} ${pairInfo}`);
      termLog("switch", `rtc dc OPEN (${this._typeDetail} ${pairInfo})`);
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
      this._everOpened = true;
      this._lastInboundAt = Date.now();
      this._setState(ADAPTER_STATE.open);
    };

    dcControl.onopen = checkOpen;
    dcBinary.onopen = checkOpen;

    // Closed only when both control and binary DCs are gone.
    const handleClose = () => {
      const cClosed = !this._dcControl || this._dcControl.readyState === "closed";
      const bClosed = !this._dcBinary || this._dcBinary.readyState === "closed";
      termLog("switch", `rtc dc-close (ctrl=${this._dcControl?.readyState} bin=${this._dcBinary?.readyState})`);
      if (cClosed && bClosed) this._setState(ADAPTER_STATE.closed);
      else this._setState(ADAPTER_STATE.degraded);
    };
    dcControl.onclose = handleClose;
    dcBinary.onclose = handleClose;
    dcFile.onclose = () => { this._dcFile = null; };

    dcControl.onerror = (e) => {
      const msg = e.error?.message ?? "unknown";
      if (!msg.includes("User-Initiated")) console.error("[rtc] dcControl ERROR:", msg);
    };
    dcBinary.onerror = (e) => {
      const msg = e.error?.message ?? "unknown";
      if (!msg.includes("User-Initiated")) console.error("[rtc] dcBinary ERROR:", msg);
    };
    dcFile.onerror = (e) => {
      const msg = e.error?.message ?? "unknown";
      if (!msg.includes("User-Initiated")) console.error("[rtc] dcFile ERROR:", msg);
    };

    dcControl.onmessage = ({ data }) => {
      this._lastInboundAt = Date.now();
      let parsed;
      // String is v1 JSON, ArrayBuffer is v2 frame.
      try {
        let decoded;
        if (typeof data === "string") decoded = decode(data);
        else {
          decoded = decodeFrame(data);
          if (!this._v2RxSeen) {
            this._v2RxSeen = true;
            termLog("switch", "env2: first v2 binary frame DECODED from agent (mutual upgrade confirmed)");
          }
        }
        parsed = this._reassemble.push(decoded);
      }
      catch (err) { console.error("[rtc] control parse error:", err.message); return; }
      if (!parsed) return;
      if (parsed.event === "__ping") {
        // Lazy-arm on first ping to avoid timing out older agents that don't ping.
        if (!this._hbTimer) this._startHeartbeatWatch();
        this._hbLastPing = Date.now();
        try { dcControl.send(encode({ event: "__pong", args: parsed.args || [] })); } catch {}
        return;
      }
      this._emit("message", { event: parsed.event, data: parsed, source: "rtc" });
    };

    dcBinary.onmessage = ({ data }) => {
      this._lastInboundAt = Date.now();
      if (data instanceof ArrayBuffer) this._receiveTile(data);
    };

    dcFile.onmessage = ({ data }) => {
      this._lastInboundAt = Date.now();
      if (data instanceof ArrayBuffer) this._emit("binary", { channel: "file", buffer: data, source: "rtc" });
    };

    pc.onicecandidate = ({ candidate }) => {
      // null candidate signals gathering complete.
      if (!candidate) {
        this._sendSignaling({ type: "ice", candidate: "", mid: this._lastMid || "0" });
        return;
      }
      this._lastMid = candidate.sdpMid;
      const m = /typ (host|srflx|relay|prflx)/.exec(candidate.candidate || "");
      if (m) this._localCandidateTypes.add(m[1]);
      const srflx = publicIpOf(candidate.candidate);
      if (srflx) this._emit("netFingerprint", srflx);
      this._sendSignaling({ type: "ice", candidate: candidate.candidate, mid: candidate.sdpMid });
    };

    pc.oniceconnectionstatechange = () => {
      debugLog("transport", `[rtc] iceState=${pc.iceConnectionState}`);
      termLog("switch", `rtc ice=${pc.iceConnectionState} types=[${[...this._localCandidateTypes].join(",")}]`);
      if (pc.iceConnectionState === "checking") this._iceReachedChecking = true;
      // Disconnected is transient, failed is terminal.
      if (pc.iceConnectionState === "disconnected") {
        this._setState(ADAPTER_STATE.degraded);
      } else if (pc.iceConnectionState === "failed") {
        this._closePeer("ice-failed");
      } else if (pc.iceConnectionState === "connected" && this._dcControl?.readyState === "open" && this._dcBinary?.readyState === "open") {
        this._setState(ADAPTER_STATE.open);
      }
    };

    this._signaling = ctx.signaling;
    this._signaling?.on?.((msg) => this._handleSignal(msg));

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      debugLog("transport", "[rtc] offer sent");
      termLog("switch", "rtc offer sent");
      this._sendSignaling({ type: "offer", sdp: offer.sdp, useTurn: this._useTurn });
    } catch (err) {
      console.error("[rtc] createOffer error:", err.message);
      this._closePeer(`create-offer:${err.message}`);
    }
  }

  // Deliberate teardown — drops signaling so adapter cannot be revived without connect().
  disconnect(reason = "?") {
    this._closePeer(`manual-disconnect by=${reason} state=${this._state}`);
    this._signaling?.off?.();
    this._signaling = null;
  }

  send(channel, payload) {
    if (channel === CHANNELS.control) {
      if (this._dcControl?.readyState !== "open") return false;
      const env = { event: payload.event, args: payload.args || [], ackId: payload.ackId || null };
      // Fragmenting requires v2 support; unfragmented oversize messages are rejected.
      if (this._peerEnv2) {
        const sent = this._sendFramed(env);
        if (!sent) return false;
        if (!this._v2Announced) {
          this._v2Announced = true;
          termLog("switch", "env2: client→agent control now SENT as v2 binary frames");
        }
        return true;
      }
      try {
        this._dcControl.send(encode(env));
        return true;
      } catch (err) {
        return false;
      }
    }
    if (channel === CHANNELS.binary) {
      if (this._dcBinary?.readyState !== "open") return false;
      try {
        this._dcBinary.send(payload);
        return true;
      } catch (err) {
        console.error("[rtc] send binary error:", err.message);
        return false;
      }
    }
    if (channel === CHANNELS.file) {
      if (this._dcFile?.readyState !== "open") return false;
      try {
        // Backpressure — generous threshold for throughput (not real-time).
        if (this._dcFile.bufferedAmount > FILE_TRANSFER.dcBufferThreshold) return false;
        this._dcFile.send(payload);
        return true;
      } catch (err) {
        console.error("[rtc] send file error:", err.message);
        return false;
      }
    }
    return false;
  }

  get typeDetail() { return this._typeDetail; }
  get isLoopback() { return this._isLoopback; }

  // ─── Signaling ─────────────────────────────────────────────────────────────

  _closePeer(reason) {
    termLog("switch", `rtc→closed reason=${reason}`);
    this._cleanupPeer();
    this._setState(ADAPTER_STATE.closed);
  }

  // Update peer capabilities (env2 binary frame, fragCtl slice reassembly).
  setPeerCaps(caps) {
    this._peerEnv2 = !!caps?.env2;
    this._peerFragCtl = !!caps?.fragCtl;
  }

  // RFC 8841 max-message-size from SCTP transport.
  get maxControlBytes() {
    return this._pc?.sctp?.maxMessageSize || CONTROL_RTC_MAX_BYTES;
  }

  // Slices v2 frames when envelope exceeds SCTP max message size.
  _sendFramed(env) {
    const max = this._peerFragCtl ? this.maxControlBytes : Infinity;
    const frames = encodeFragments(env, max, ++this._fragSeq);
    if (!frames) return false;
    try {
      for (const frame of frames) this._dcControl.send(frame);
      return true;
    } catch (err) {
      debugLog("transport", `[rtc] control send refused: ${err.message}`);
      return false;
    }
  }

  // Closes stalled peer if no ping received within heartbeat timeout.
  _startHeartbeatWatch() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    this._hbLastPing = Date.now();
    this._hbTimer = setInterval(() => {
      if (this._state !== ADAPTER_STATE.open) {
        clearInterval(this._hbTimer); this._hbTimer = null;
        return;
      }
      const silent = Date.now() - this._hbLastPing;
      if (silent > RTC_HEARTBEAT_TIMEOUT_MS) {
        debugLog("transport", `[rtc] heartbeat: no ping for ${silent}ms → closing stalled peer`);
        this._closePeer(`heartbeat-stale (${silent}ms)`);
      }
    }, RTC_HEARTBEAT_INTERVAL_MS);
  }

  /** Empty candidate = end-of-candidates; the spec spells it as a bare "" line. */
  async _addRemoteCandidate({ candidate, mid }) {
    if (!candidate) this._remoteGatheringDone = true;
    const init = candidate ? { candidate, sdpMid: mid } : { candidate: "", sdpMid: mid || "0" };
    await this._pc.addIceCandidate(new RTCIceCandidate(init)).catch(() => {});
  }

  // Close peer early when both sides finished gathering and all candidate pairs failed.
  _startDeadPathWatch() {
    clearInterval(this._deadPathTimer);
    this._deadPathTimer = setInterval(async () => {
      if (this._state === ADAPTER_STATE.open || !this._pc) return this._stopDeadPathWatch();
      if (!this._remoteGatheringDone || this._pc.iceGatheringState !== "complete") return;
      let pairs = 0, dead = 0;
      try {
        (await this._pc.getStats()).forEach((r) => {
          if (r.type !== "candidate-pair") return;
          pairs++;
          if (r.state === "failed") dead++;
        });
      } catch { return; }
      // Gathering can complete before the first pair is formed.
      if (!pairs || dead < pairs) return;
      this._stopDeadPathWatch();
      this._closePeer(`dead-path (${dead} pair(s) failed)`);
    }, DEAD_PATH_POLL_MS);
  }

  _stopDeadPathWatch() {
    clearInterval(this._deadPathTimer);
    this._deadPathTimer = null;
  }

  _sendSignaling(msg) {
    this._signaling?.send?.(msg);
  }

  async _handleSignal(msg) {
    debugLog("transport", `[rtc] signal: ${msg.type}`);
    termLog("switch", `rtc signal recv=${msg.type}`);
    if (!this._pc) return;
    try {
      if (msg.type === "answer") {
        // Ignore duplicate answer to prevent setRemoteDescription throw.
        if (this._answerApplied || this._pc.signalingState === "stable") {
          debugLog("transport", "[rtc] duplicate answer ignored");
          termLog("switch", "rtc duplicate answer ignored");
          return;
        }
        // Verify signed answer against pinned host key or pairing fp2.
        if (msg.pub && msg.sig) {
          const ok = await this._verifyHostAnswer(msg);
          if (!ok) {
            console.error("[rtc] host key verification FAILED — relayed answer rejected");
            this._closePeer("host-key-rejected");
            return;
          }
        }
        await this._pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
        this._answerApplied = true;
        debugLog("transport", "[rtc] answer set");
        termLog("switch", "rtc answer applied");
        // Apply candidates that arrived before the answer.
        const queued = this._pendingCandidates;
        this._pendingCandidates = [];
        for (const m of queued) await this._addRemoteCandidate(m);
        // Answer received; restart timer to give ICE its full window.
        clearTimeout(this._connectTimer);
        this.connectDeadline = Date.now() + RTC_ICE_TIMEOUT_MS;
        this._startDeadPathWatch();
        this._connectTimer = setTimeout(async () => {
          if (this._state === ADAPTER_STATE.open) return;
          try {
            const stats = await this._pc.getStats();
            stats.forEach((r) => {
              if (r.type !== "candidate-pair") return;
              const l = stats.get(r.localCandidateId), rmt = stats.get(r.remoteCandidateId);
              const la = (l?.address || l?.ip || "?").split(":")[0].slice(-12);
              const ra = (rmt?.address || rmt?.ip || "?");
              termLog("switch", `pair ${r.state} ${l?.candidateType}:${la}→${rmt?.candidateType}:${ra}`);
            });
          } catch {}
          this._closePeer(`ice-timeout (state=${this._state})`);
        }, RTC_ICE_TIMEOUT_MS);
      } else if (msg.type === "ice") {
        // Buffer candidates arriving before setRemoteDescription completes.
        if (!this._answerApplied) { this._pendingCandidates.push(msg); return; }
        await this._addRemoteCandidate(msg);
      } else if (msg.type === "error") {
        debugLog("transport", `[rtc] server error: ${msg.message}`);
        this._closePeer(`server-error:${msg.message}`);
      }
    } catch (err) {
      console.error("[rtc] signal handle error:", err.message);
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  // Verify answer signature with pinned key or pairing fp2.
  async _verifyHostAnswer(msg) {
    const apiKey = this._ctx?.auth?.apiKey;
    if (!apiKey) return true;
    const trust = getTrust(apiKey);
    const pinned = trust?.hostPubKey ? trust : null;
    const fp2Usable = !!trust?.hostSealKey;
    debugLog("auth", "[seal] verify answer:", {
      agentSentXpub: !!msg.xpub,
      pinned: !!pinned,
      stalePin: !!(trust?.hostPubKey && !fp2Usable),
      pendingFp2: getPendingFp2()
    });
    if (pinned) {
      if (pinned.hostPubKey !== msg.pub) {
        // Re-pin if fresh pairing fp2 matches, otherwise reject.
        const pendingFp2 = getPendingFp2();
        if (pendingFp2 && (await hostFingerprint(msg.pub, msg.xpub)) === pendingFp2) {
          setTrust(apiKey, { hostPubKey: msg.pub, hostSealKey: msg.xpub, fp2: pendingFp2 });
          debugLog("transport", "[rtc] host key re-pinned via fresh pairing fp2");
          return true;
        }
        debugLog("auth", "[seal] REJECT answer — pinned pub differs (host key rotated?) and no fresh fp2 to re-pin");
        return false;
      }
      const sig = await verifySdpSignature(msg.pub, msg.sdp, msg.sig);
      if (sig === false) {
        debugLog("auth", "[seal] REJECT answer — signature invalid (relay tampering?)");
        return false;
      }
      if (sig === null) {
        // Browser without Ed25519: verify against stored fp2.
        if (!fp2Usable) {
          debugLog("auth", "[seal] REJECT answer — no Ed25519 in browser and pinned fp2 predates sealing");
          return false;
        }
        const fp2ok = (await hostFingerprint(msg.pub, msg.xpub)) === pinned.fp2;
        if (!fp2ok) debugLog("auth", "[seal] REJECT answer — fp2 fallback mismatch vs pinned", pinned.fp2);
        return fp2ok;
      }
      return true;
    }
    const pendingFp2 = getPendingFp2();
    if (pendingFp2) {
      const fp2 = await hostFingerprint(msg.pub, msg.xpub);
      if (fp2 !== pendingFp2) {
        debugLog("auth", "[seal] REJECTED — fp2", fp2, "!= code", pendingFp2,
          msg.xpub ? "" : "(agent sent no sealing key — needs the source build)");
        // Clear pending fp2 on mismatch to prevent stale codes blocking future attempts.
        takePendingFp2();
        return false;
      }
      setTrust(apiKey, { hostPubKey: msg.pub, hostSealKey: msg.xpub, fp2 });
      debugLog("auth", "[seal] pinned via RTC — fp2", fp2, "sealing key stored");
      debugLog("transport", "[rtc] host key pinned via pairing fp2");
      return true;
    }
    return true;
  }

  // Classify NAT type ("ok", "hard", "unknown") from observed ICE behavior.
  natVerdict() {
    const types = this._localCandidateTypes;
    if (this._everOpened || types.has("relay")) return "ok";
    if (types.size === 0) return "unknown";
    if (!types.has("srflx")) return "hard";
    // Symmetric NAT: srflx gathered and agent answered, but never reached checking.
    if (this._answerApplied && !this._iceReachedChecking) return "hard";
    return "unknown";
  }

  _cleanupPeer() {
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._stopDeadPathWatch();
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    for (const dc of [this._dcControl, this._dcBinary, this._dcFile]) {
      if (!dc) continue;
      dc.onopen = null; dc.onclose = null; dc.onerror = null; dc.onmessage = null;
      try { dc.close(); } catch {}
    }
    this._dcControl = null;
    this._dcBinary = null;
    this._dcFile = null;
    this._isLoopback = false;
    this._typeDetail = "dc-stun";
    if (this._pc) {
      this._pc.onicecandidate = null;
      this._pc.oniceconnectionstatechange = null;
      try { this._pc.close(); } catch {}
      this._pc = null;
    }
    this._pendingEmit = null;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._latestTileTs.clear();
    // Reset reassembler to drop incomplete slices from torn-down peer.
    this._reassemble = createReassembler();
  }

  _receiveTile(buffer) {
    const id = ++_workerMsgId;
    const bytes = buffer.byteLength;
    new Promise((resolve) => {
      // Timeout if decoder worker hangs or terminates.
      const timer = setTimeout(() => {
        if (!_workerPending.has(id)) return;
        _workerPending.delete(id);
        resolve(null);
      }, WORKER_DECODE_TIMEOUT_MS);
      // Drop oldest in-flight decode if queue exceeds cap.
      const cap = REMOTE_CONFIG.decodeQueueCap;
      while (_workerPending.size >= cap) {
        const oldestId = _workerPending.keys().next().value;
        const old = _workerPending.get(oldestId);
        if (!old) break;
        clearTimeout(old.timer);
        _workerPending.delete(oldestId);
        old.resolve(null);
      }
      const worker = getWorker();
      if (!worker) { clearTimeout(timer); _workerPending.delete(id); resolve(null); return; }
      _workerPending.set(id, { resolve, timer });
      worker.postMessage({ buffer, id, v: 2 }, [buffer]);
    }).then((result) => {
      if (!result) return;
      const { tiles, timestamp, hasBitmap } = result;

      if (!this._pendingEmit) this._pendingEmit = { tiles: new Map(), timestamp, hasBitmap, bytes: 0 };
      this._pendingEmit.bytes += bytes;
      for (const tile of tiles) {
        const prev = this._latestTileTs.get(tile.tileIndex) ?? 0;
        if (timestamp >= prev) {
          this._latestTileTs.set(tile.tileIndex, timestamp);
          this._pendingEmit.tiles.get(tile.tileIndex)?.bitmap?.close?.();
          this._pendingEmit.tiles.set(tile.tileIndex, tile);
          if (timestamp > this._pendingEmit.timestamp) this._pendingEmit.timestamp = timestamp;
        } else {
          tile.bitmap?.close?.();
        }
      }

      if (this._flushTimer) clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        if (!this._pendingEmit) return;
        const { tiles: tileMap, timestamp: ts, hasBitmap: hb, bytes: by } = this._pendingEmit;
        this._pendingEmit = null;
        const freshTiles = [...tileMap.values()];
        if (!freshTiles.length) return;
        this._emit("message", {
          event: "tiles-data",
          data: { tiles: freshTiles, timestamp: ts, hasBitmap: hb, bytes: by, transport: this._typeDetail },
          source: "rtc"
        });
      }, 0);
    });
  }
}

// Extracts public IP from a server-reflexive (srflx) candidate.
function publicIpOf(candidate) {
  if (!candidate || !candidate.includes("typ srflx")) return null;
  const parts = candidate.split(" ");
  return parts[4] || null;
}
