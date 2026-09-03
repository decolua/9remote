import { BaseProtocol } from "./BaseProtocol";
import { encode, decode, encodeFrame, decodeFrame } from "./codec";
import { API_ENDPOINTS } from "@/shared/constants/API";
import { ADAPTER_STATE, CHANNELS, DEAD_PATH_POLL_MS, FILE_TRANSFER, RTC_CONNECT_TIMEOUT_MS, RTC_ICE_TIMEOUT_MS, RTC_HEARTBEAT_INTERVAL_MS, RTC_HEARTBEAT_TIMEOUT_MS } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { getTrust, setTrust, getPendingFp2, takePendingFp2, hostFingerprint, verifySdpSignature } from "./lib/deviceTrust";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

// Shared decoder worker (one instance for all WebRtcProtocol instances)
let _worker = null;
let _workerMsgId = 0;
const _workerPending = new Map();
// Per-pending decode timeout — a worker suspended/killed by iOS background or a crash
// stops answering; without this guard every pending decode promise hangs forever and
// tiles never draw (black canvas on the RTC path). Mirror useTiles.resetBinWorker.
const WORKER_DECODE_TIMEOUT_MS = 8000;
// Consecutive worker crashes before giving up — a worker that fails to load (CSP)
// errors again on every respawn, so bound the retries instead of looping forever.
const MAX_WORKER_RESPAWNS = 3;
let _workerFailures = 0;

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
    _workerFailures = 0; // worker answered — the crash streak is broken
    const entry = _workerPending.get(id);
    if (!entry) {
      // Batch was dropped by the queue cap before this result arrived — close the
      // orphan bitmaps the worker decoded so they don't leak GPU memory.
      if (tiles) for (const t of tiles) t.bitmap?.close?.();
      return;
    }
    clearTimeout(entry.timer);
    _workerPending.delete(id);
    entry.resolve(error ? null : { tiles, timestamp, hasBitmap });
  };
  _worker.onerror = (err) => {
    console.error("[Worker] tileDecoder:", err.message);
    // A crashed worker won't answer any pending decode — reset so the next tile spawns
    // a fresh worker instead of posting into a dead one.
    resetWorker();
    if (++_workerFailures >= MAX_WORKER_RESPAWNS) _worker = false;
  };
  return _worker;
}

// Terminate the (possibly suspended/crashed) worker + drop pending decodes so the next
// tile spawns a fresh worker. Mirrors useTiles.resetBinWorker (iOS background recovery).
function resetWorker() {
  if (_worker) { try { _worker.terminate(); } catch {} }
  _worker = null;
  for (const { resolve } of _workerPending.values()) { try { resolve(null); } catch {} }
  _workerPending.clear();
}

/**
 * WebRtcProtocol — RTCDataChannel transport adapter (browser).
 *
 * Two DCs:
 *   "control" — ordered/reliable — JSON control events
 *   "binary"  — unordered/unreliable — binary tile frames (decoded → "message" tiles-data)
 *
 * Signaling: cross-channel via ProtocolManager (defaults WS, falls back to HTTP).
 * Adapter is signaling-agnostic — gets `signaling` interface from connect ctx.
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
    this._typeDetail = "dc-stun";
    // NAT classification (anti-spam) — see natVerdict(). Tracks the local
    // candidate types gathered, whether the agent answered (signaling reached it),
    // and whether the DC ever opened. "Answered but never opened" is the signal
    // for a connectivity failure; we cannot wait for ICE "failed" because
    // _connectTimer closes the peer long before the browser declares it.
    this._localCandidateTypes = new Set();
    this._answerApplied = false;
    this._pendingCandidates = [];
    this._iceReachedChecking = false;
    this._everOpened = false;

    this._pendingEmit = null;
    this._flushTimer = null;
    this._latestTileTs = new Map();

    // Heartbeat staleness (agent pings, we pong): a stalled SCTP reports "open"
    // while blackholing messages — no ping for interval+grace means dead.
    this._hbTimer = null;
    this._hbLastPing = 0;
    // Agent announced the v2 binary envelope (srvCaps.env2) — until then, send v1
    // text so an old agent still parses us. Set by PM: srvCaps arrives on whichever
    // carrier is up first, which is usually WS (RTC is still gathering ICE), so it
    // must not be read off this adapter's own channel.
    this._peerEnv2 = false;
    this._v2Announced = false; // one-shot: first v2 frame we SEND
    this._v2RxSeen = false;    // one-shot: first v2 frame we DECODE
    this._lastInboundAt = 0;

    this._signalingHandlers = {};
    this._signaling = null;
  }

  get lastInboundAt() { return this._lastInboundAt; }

  /**
   * @param {object} ctx
   * @param {object} ctx.auth         — { apiKey }
   * @param {object} ctx.profile      — { rtc: { enableTurn } }
   * @param {object} ctx.signaling    — { send(msg), on(handler), off() }
   */
  async connect(ctx) {
    this._ctx = ctx;
    this._cleanupPeer();
    // Bumped per peer so per-connection work (the TAIL proof) re-runs against a
    // restarted agent but not on every reopen of the same peer's channel.
    this._peerEpoch = (this._peerEpoch ?? 0) + 1;
    // Fresh NAT classification per peer — candidate types accumulate as ICE gathers.
    this._localCandidateTypes = new Set();
    this._answerApplied = false;
    this._pendingCandidates = [];
    this._iceReachedChecking = false;
    this._everOpened = false;
    this._lastMid = null;
    this._remoteGatheringDone = false;
    this._setState(ADAPTER_STATE.connecting);
    this.connectingSince = Date.now(); // age guard for the restart loop's stale-kill
    // The deadline this peer is actually being judged against. The restart loop
    // used to assume RTC_CONNECT_TIMEOUT_MS and killed peers at ~5s — but an
    // answered peer extends itself to RTC_ICE_TIMEOUT_MS below, so ICE lost two
    // thirds of the window it was given. Publishing the deadline keeps the two
    // clocks from drifting: whoever moves the timer moves this with it.
    this.connectDeadline = this.connectingSince + RTC_CONNECT_TIMEOUT_MS;
    // Offer may be dropped by the DO relay if the agent hasn't joined its room yet
    // (forward-only, no store) → no answer → ICE never runs → stuck "connecting".
    // Timeout converts that into a closed → PM re-offer; later retries hit a ready agent.
    clearTimeout(this._connectTimer);
    this._connectTimer = setTimeout(() => {
      if (this._state === ADAPTER_STATE.open) return;
      debugLog("transport", `[rtc] connect timeout (${RTC_CONNECT_TIMEOUT_MS}ms, state=${this._state}) → close + retry`);
      this._closePeer(`connect-timeout (state=${this._state})`);
    }, RTC_CONNECT_TIMEOUT_MS);

    // Full cluster (see the agent's DEFAULT_ICE note): each server is a separate
    // bus and therefore a separate CGNAT mapping, and carriers admit inbound
    // UDP per-port inconsistently — the extra mappings are what keep cellular
    // networks connectable. Benchmarked from VN: Google ~150ms, Twilio ~144ms,
    // Cloudflare ~813ms; the checking tail is absorbed by the ICE window.
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
    if (ctx.profile?.rtc?.enableTurn) {
      try {
        const resp = await fetch(API_ENDPOINTS.turnCredentials, { headers: { "X-API-Key": ctx.auth.apiKey } });
        if (resp.ok) iceServers = (await resp.json()).iceServers;
      } catch (err) {
        console.warn("[WebRtcProtocol] TURN fetch failed:", err.message);
      }
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
            if (local?.candidateType === "relay") this._typeDetail = "dc-turn";
            pairInfo = `local=${local?.candidateType}/${local?.protocol} remote=${remote?.candidateType}/${remote?.protocol}`;
          }
        });
      } catch {}
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

    // Closed only when BOTH control+binary gone — single DC close = degraded.
    // The file DC is secondary: its close doesn't govern adapter state.
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
      // The DC itself tells the two wire forms apart: a string is v1 JSON, an
      // ArrayBuffer is a v2 frame (binaryType is "arraybuffer"). No sniffing.
      try {
        if (typeof data === "string") parsed = decode(data);
        else {
          parsed = decodeFrame(data);
          if (!this._v2RxSeen) {
            this._v2RxSeen = true;
            termLog("switch", "env2: first v2 binary frame DECODED from agent (mutual upgrade confirmed)");
          }
        }
      }
      catch (err) { console.error("[rtc] control parse error:", err.message); return; }
      if (parsed.event === "__ping") {
        // Lazy-arm on the first ping: an old agent never pings, and a watch armed
        // at DC-open would kill its healthy RTC after one timeout of silence.
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

    // File DC carries raw binary frames (download chunks from agent).
    dcFile.onmessage = ({ data }) => {
      this._lastInboundAt = Date.now();
      if (data instanceof ArrayBuffer) this._emit("binary", { channel: "file", buffer: data, source: "rtc" });
    };

    pc.onicecandidate = ({ candidate }) => {
      // null candidate = gathering complete. libjuice will not fail faster for it,
      // but the agent mirrors the marker back and our dead-path watch needs it.
      if (!candidate) {
        this._sendSignaling({ type: "ice", candidate: "", mid: this._lastMid || "0" });
        return;
      }
      this._lastMid = candidate.sdpMid;
      // Record the local candidate type for NAT classification ("typ host|srflx|relay|prflx").
      const m = /typ (host|srflx|relay|prflx)/.exec(candidate.candidate || "");
      if (m) this._localCandidateTypes.add(m[1]);
      const srflx = publicIpOf(candidate.candidate);
      if (srflx) this._emit("netFingerprint", srflx);
      this._sendSignaling({ type: "ice", candidate: candidate.candidate, mid: candidate.sdpMid });
    };

    pc.oniceconnectionstatechange = () => {
      debugLog("transport", `[rtc] iceState=${pc.iceConnectionState}`);
      termLog("switch", `rtc ice=${pc.iceConnectionState} types=[${[...this._localCandidateTypes].join(",")}]`);
      // Reaching "checking" means pairs were actually being probed — see natVerdict.
      if (pc.iceConnectionState === "checking") this._iceReachedChecking = true;
      // disconnected: transient — peer may recover. Only failed = terminal.
      if (pc.iceConnectionState === "disconnected") {
        this._setState(ADAPTER_STATE.degraded);
      } else if (pc.iceConnectionState === "failed") {
        this._closePeer("ice-failed");
      } else if (pc.iceConnectionState === "connected" && this._dcControl?.readyState === "open" && this._dcBinary?.readyState === "open") {
        this._setState(ADAPTER_STATE.open);
      }
    };

    // Setup signaling channel
    this._signaling = ctx.signaling;
    this._signaling?.on?.((msg) => this._handleSignal(msg));

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      debugLog("transport", "[rtc] offer sent");
      termLog("switch", "rtc offer sent");
      this._sendSignaling({ type: "offer", sdp: offer.sdp });
    } catch (err) {
      console.error("[rtc] createOffer error:", err.message);
      this._closePeer(`create-offer:${err.message}`);
    }
  }

  /** Deliberate teardown — unlike _closePeer it also drops signaling, so the
   *  adapter cannot be revived without a fresh connect(). */
  disconnect(reason = "?") {
    this._closePeer(`manual-disconnect by=${reason} state=${this._state}`);
    this._signaling?.off?.();
    this._signaling = null;
  }

  send(channel, payload) {
    if (channel === CHANNELS.control) {
      if (this._dcControl?.readyState !== "open") return false;
      try {
        const env = { event: payload.event, args: payload.args || [], ackId: payload.ackId || null };
        // v2 binary frame once the agent announced it — buffers ride raw instead
        // of base64 inside JSON. Old agents keep the text form.
        if (this._peerEnv2) {
          if (!this._v2Announced) {
            this._v2Announced = true;
            termLog("switch", "env2: client→agent control now SENT as v2 binary frames");
          }
          this._dcControl.send(encodeFrame(env));
        } else this._dcControl.send(encode(env));
        return true;
      } catch (err) {
        console.error("[rtc] send control error:", err.message);
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

  // ─── Signaling ─────────────────────────────────────────────────────────────

  /** The only way this adapter dies: log the reason, drop the peer, publish closed.
   *  Seven sites did these three steps by hand — one that skipped cleanup would
   *  leak a peer while PM saw a closed adapter. */
  _closePeer(reason) {
    termLog("switch", `rtc→closed reason=${reason}`);
    this._cleanupPeer();
    this._setState(ADAPTER_STATE.closed);
  }

  /** PM forwards the agent's srvCaps announcement (it may arrive on either
   *  carrier). env2 flips this adapter's sender to the v2 binary frame. */
  setPeerCaps(caps) {
    this._peerEnv2 = !!caps?.env2;
  }

  /** Ping-staleness watch — armed lazily on the first __ping (see onmessage).
   *  The agent pings every RTC_HEARTBEAT_INTERVAL_MS; silence past interval+grace
   *  means the peer is stalled (SCTP "open" but blackholing) — close it so the PM
   *  routes around to WS and the restart loop can re-offer. */
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

  /**
   * Close a provably dead peer instead of waiting out RTC_ICE_TIMEOUT_MS.
   *
   * No engine reports this for us: libjuice ignores end-of-candidates for
   * failure detection, and no browser implements the spec's "all pairs failed →
   * failed" transition (w3c/webrtc-pc#2698), so ICE just stalls in "checking"
   * for ~40s. We decide ourselves, but only on complete evidence — both sides
   * done gathering AND every pair terminal. Anything less keeps waiting: a slow
   * dual-stack gather legitimately takes seconds before its first usable pair.
   */
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
      // Zero pairs is not evidence of failure — gathering can complete before
      // the first pair is even formed.
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
        // Duplicate/replayed answer (DO redelivery after a WS blip) — the first one
        // already applied and the connection is fine; a second setRemoteDescription
        // would throw "wrong state: stable".
        if (this._answerApplied || this._pc.signalingState === "stable") {
          debugLog("transport", "[rtc] duplicate answer ignored");
          termLog("switch", "rtc duplicate answer ignored");
          return;
        }
        // Signed answer — verify against the pinned host key (or the pairing
        // fp2 on first contact) before trusting the relayed SDP.
        if (msg.pub && msg.sig) {
          const ok = await this._verifyHostAnswer(msg);
          if (!ok) {
            console.error("[rtc] host key verification FAILED — relayed answer rejected");
            this._closePeer("host-key-rejected");
            return;
          }
        }
        await this._pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
        this._answerApplied = true; // signaling reached the agent — a later failure is connectivity, not routing
        debugLog("transport", "[rtc] answer set");
        termLog("switch", "rtc answer applied");
        // Candidates that raced the answer were buffered (addIceCandidate throws
        // before a remote description exists); apply them now, in order.
        const queued = this._pendingCandidates;
        this._pendingCandidates = [];
        for (const m of queued) await this._addRemoteCandidate(m);
        // The connect timer covers "did the agent answer at all", and it started
        // when the offer went out. The agent gathers against seven STUN servers
        // before it can answer (~2s observed), which used to eat most of the
        // budget and leave ICE a fraction of a second — the peer then died on
        // timeout and retried forever. An answer proves the agent is alive, so
        // restart the clock and give ICE its own full window.
        clearTimeout(this._connectTimer);
        this.connectDeadline = Date.now() + RTC_ICE_TIMEOUT_MS;
        this._startDeadPathWatch();
        this._connectTimer = setTimeout(async () => {
          if (this._state === ADAPTER_STATE.open) return;
          // Pair states explain WHY the backstop fired rather than the fast path
          // — the dead-path watch only closes when every pair is "failed".
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
        // The agent sends its answer and candidates back-to-back, so candidates
        // regularly land while setRemoteDescription is still in flight — the
        // browser rejects them (InvalidStateError) and swallowing that here
        // silently dropped the agent's host candidate. Losing the LAN pair left
        // only srflx through a carrier NAT, which never connects — the
        // "sometimes RTC works, sometimes not" coin flip. Buffer until the
        // answer applies (mirrors the agent's _pendingCandidates).
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

  /**
   * Host-key verification for a signed answer (see .docs/PLAN-e2e-key-security.md):
   * - pinned key: the answer must be signed by exactly that key
   * - first contact during pairing: fp2 from the pairing code must match
   * - no pin and no pending fp2 (legacy agent / manual key login): accept
   * Returns true when the answer may be trusted.
   */
  async _verifyHostAnswer(msg) {
    const apiKey = this._ctx?.auth?.apiKey;
    if (!apiKey) return true;
    const trust = getTrust(apiKey);
    // A pin from before sealing carries a signing key but no sealing key, and
    // its fp2 came from a scheme this build cannot reproduce. The KEY is still
    // a real anchor — it was pinned out-of-band once — so it keeps deciding who
    // may answer. Only the fingerprint is unusable, which matters in two
    // places: re-pinning a rotated key, and the fp2 fallback for browsers
    // without Ed25519. Both fall through to pairing instead of comparing
    // against a value that can never match.
    const pinned = trust?.hostPubKey ? trust : null;
    const fp2Usable = !!trust?.hostSealKey;
    // TEMP DIAGNOSTIC — sealing rollout; remove once verified end to end
    console.log("[seal] verify answer:", {
      agentSentXpub: !!msg.xpub,
      pinned: !!pinned,
      stalePin: !!(trust?.hostPubKey && !fp2Usable),
      pendingFp2: getPendingFp2()
    });
    if (pinned) {
      if (pinned.hostPubKey !== msg.pub) {
        // Pinned key differs: either the agent's host key rotated (reinstall)
        // or a relay is swapping the peer. A fresh pairing fp2 that matches
        // the new key is out-of-band consent to re-pin; otherwise reject.
        const pendingFp2 = getPendingFp2();
        if (pendingFp2 && (await hostFingerprint(msg.pub, msg.xpub)) === pendingFp2) {
          setTrust(apiKey, { hostPubKey: msg.pub, hostSealKey: msg.xpub, fp2: pendingFp2 });
          debugLog("transport", "[rtc] host key re-pinned via fresh pairing fp2");
          return true;
        }
        console.log("[seal] REJECT answer — pinned pub differs (host key rotated?) and no fresh fp2 to re-pin");
        return false;
      }
      // Same key as pinned: the signature is the check, and it works whatever
      // scheme the stored fingerprint used.
      const sig = await verifySdpSignature(msg.pub, msg.sdp, msg.sig);
      if (sig === false) {
        console.log("[seal] REJECT answer — signature invalid (relay tampering?)");
        return false;
      }
      if (sig === null) {
        // Browser without Ed25519 WebCrypto — the stored fp2 is all that is
        // left, and a pre-sealing one cannot be recomputed. Refuse rather than
        // accept unverified: the user re-pairs and gets a fingerprint that works.
        if (!fp2Usable) {
          console.log("[seal] REJECT answer — no Ed25519 in browser and pinned fp2 predates sealing");
          return false;
        }
        const fp2ok = (await hostFingerprint(msg.pub, msg.xpub)) === pinned.fp2;
        if (!fp2ok) console.log("[seal] REJECT answer — fp2 fallback mismatch vs pinned", pinned.fp2);
        return fp2ok;
      }
      return true;
    }
    const pendingFp2 = getPendingFp2();
    if (pendingFp2) {
      const fp2 = await hostFingerprint(msg.pub, msg.xpub);
      if (fp2 !== pendingFp2) {
        console.log("[seal] REJECTED — fp2", fp2, "!= code", pendingFp2,
          msg.xpub ? "" : "(agent sent no sealing key — needs the source build)");
        // Single-shot: a mismatch burns the pending fp2 so a stale one (wrong
        // code, expired pairing of another agent) can't reject the right agent
        // for the rest of the tab session.
        takePendingFp2();
        return false;
      }
      setTrust(apiKey, { hostPubKey: msg.pub, hostSealKey: msg.xpub, fp2 });
      console.log("[seal] pinned via RTC — fp2", fp2, "sealing key stored");
      debugLog("transport", "[rtc] host key pinned via pairing fp2");
      return true;
    }
    return true; // no out-of-band anchor available — legacy behavior
  }

  /**
   * Classify this network's NAT from what this peer attempt observed.
   * "ok"      — TURN relay available, or the DC opened at least once.
   * "hard"    — the agent answered (so signaling works) yet the DC never opened
   *             despite srflx candidates: symmetric NAT. Or only host candidates
   *             were gathered at all: STUN/UDP blocked. Neither can do P2P.
   * "unknown" — no answer yet (agent offline / DO drop) or nothing gathered:
   *             a retry may still succeed, so don't give up.
   * Note: we deliberately do NOT wait for ICE "failed" — _connectTimer closes the
   * peer after RTC_CONNECT_TIMEOUT_MS, long before the browser declares failure.
   * Used by ProtocolManager to decide whether another DO round-trip is worth it.
   */
  natVerdict() {
    const types = this._localCandidateTypes;
    if (this._everOpened || types.has("relay")) return "ok";
    if (types.size === 0) return "unknown";        // nothing gathered — no signal
    if (!types.has("srflx")) return "hard";        // host/prflx only → STUN/UDP blocked
    // srflx present and the agent answered, yet nothing opened. That reads as a
    // symmetric NAT only if ICE actually got to try: a dual-stack client that
    // reached "checking" was working through IPv6 pairs and may well succeed on
    // the IPv4 ones (89ms once it got there), so calling that hard NAT gave up
    // on a path that works and pinned the session to the tunnel.
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
    if (this._pc) {
      this._pc.onicecandidate = null;
      this._pc.oniceconnectionstatechange = null;
      try { this._pc.close(); } catch {}
      this._pc = null;
    }
    this._pendingEmit = null;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._latestTileTs.clear();
  }

  _receiveTile(buffer) {
    const id = ++_workerMsgId;
    const bytes = buffer.byteLength;
    new Promise((resolve) => {
      // Per-pending timeout — if the worker is suspended (iOS background) or dead it
      // never answers; resolve(null) drops this frame instead of hanging the promise.
      const timer = setTimeout(() => {
        if (!_workerPending.has(id)) return;
        _workerPending.delete(id);
        resolve(null);
      }, WORKER_DECODE_TIMEOUT_MS);
      // Bound the in-flight queue: if the worker can't keep up, drop the OLDEST
      // batch (first inserted ≈ oldest frame) so the newest frame always wins.
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
        // Emit as standard "message" → ProtocolManager fans out to "tiles-data" listeners
        this._emit("message", {
          event: "tiles-data",
          data: { tiles: freshTiles, timestamp: ts, hasBitmap: hb, bytes: by, transport: this._typeDetail },
          source: "rtc"
        });
      }, 0);
    });
  }
}

// Public IP from a server-reflexive candidate — the NAT address STUN observed.
// It changes on every real network handover (wifi ⇄ cellular ⇄ another AP), so
// it's a reliable network identity where navigator.connection isn't available.
// Candidate form: "candidate:<foundation> <comp> <proto> <pri> <ip> <port> typ srflx ..."
function publicIpOf(candidate) {
  if (!candidate || !candidate.includes("typ srflx")) return null;
  const parts = candidate.split(" ");
  return parts[4] || null;
}
