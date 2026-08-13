import { WsProtocol } from "./WsProtocol";
import { WebRtcProtocol } from "./WebRtcProtocol";
import { registerProtocol, getProtocol } from "./registry";
import { TRANSPORT_PROFILES, CHANNELS, ADAPTER_STATE, CONTROL_RTC_MAX_BYTES, RTC_RESTART, REJOIN_DEBOUNCE_MS, RTC_CONNECT_TIMEOUT_MS, RESUME_PROBE_TIMEOUT_MS, STUN_PROBE, SIGNALING_CONFIG, NET_RECOVERY, SIGNALING_ERRORS } from "@/shared/constants/transport";
import { WORKER_API } from "@/shared/constants/API";
import { isWsZombie } from "./wsZombie";
import { probePublicIp, shouldRearmOnIpChange, NO_PUBLIC_IP } from "./stunProbe";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";

// Auto-register built-in adapters
registerProtocol(WsProtocol);
registerProtocol(WebRtcProtocol);

// TEMP DIAGNOSTIC — remove once the RTC restart loop is fixed.
// Names the call site that triggered a restart/disconnect so the loop's driver
// is identifiable from the log instead of guessed.
function callerTrace(depth = 3) {
  const lines = (new Error().stack || "").split("\n").slice(2, 2 + depth);
  return lines
    .map((l) => (l.match(/at\s+([\w.<>_$]+)/) || [])[1] || "?")
    .filter((n) => n && n !== "?")
    .join("<");
}

// Carrier NAT pools give neighbour IPs for the same network. Compare on the
// /24 so a flip-flop between two STUN egresses isn't treated as a handover.
function sameNetwork(a, b) {
  const pa = (a || "").split(".");
  const pb = (b || "").split(".");
  return pa.length === 4 && pb.length === 4 && pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
}

// Sum responsesReceived over the nominated/selected ICE candidate-pairs of a
// RTCStatsReport. Returns null if no selected pair exists yet (still gathering).
// Used by the resume probe to tell a live DC (counter grows from STUN keepalives)
// from a frozen/zombie one (counter flat) without any agent cooperation.
function selectedIceResponses(report) {
  let total = 0, found = false;
  for (const v of report.values()) {
    if (v.type === "candidate-pair" && (v.nominated || v.selected)) {
      found = true;
      total += v.responsesReceived ?? 0;
    }
  }
  return found ? total : null;
}

/**
 * ProtocolManager — orchestrator. Holds auth, instantiates adapters from profile,
 * routes messages by channel via priority, auto-reroutes on stateChange.
 *
 * Backward-compat API kept (on/off/emit/connect/disconnect, socketRef, type, connected, connectionMode).
 */
export class ProtocolManager {
  constructor(wsConfig, rtcConfig) {
    // Map legacy config → unified shape
    const profileId = rtcConfig?.enableWebRTC ? "remoteDesktop" : "clientApp";
    const profile = { ...TRANSPORT_PROFILES[profileId] };
    if (!rtcConfig?.enableWebRTC) profile.enabled = ["ws"];
    if (rtcConfig?.enableTurn) profile.rtc = { ...profile.rtc, enableTurn: true };

    this._profile = profile;
    this._auth = {
      tunnelUrl: wsConfig.tunnelUrl,
      localIp: wsConfig.localIp,
      apiKey: wsConfig.apiKey,
      tempKey: wsConfig.tempKey,
      deviceId: wsConfig.deviceId,
      namespace: wsConfig.namespace,
      socketOptions: wsConfig.socketOptions
    };
    this._wsCallbacks = {
      onConnect: wsConfig.onConnect,
      onDisconnect: wsConfig.onDisconnect,
      onRetryStatus: wsConfig.onRetryStatus,
      onUrlUpdate: wsConfig.onUrlUpdate,
      onApproval: wsConfig.onApproval
    };
    this._rtcCallbacks = rtcConfig ? {
      onUpgrade: rtcConfig.onUpgrade,
      onFallback: rtcConfig.onFallback,
      onTransportChange: rtcConfig.onTransportChange
    } : {};

    // Signaling identity — per PM instance, so two tabs of the same browser
    // (same deviceId, shared localStorage) get independent RTC sessions.
    this._peerId = `${wsConfig.deviceId}:${_randomTag()}`;
    // Socket.io carries the peerId so the agent can match a tunnel connection to
    // an existing RTC-only session instead of building a second PM.
    if (this._auth.socketOptions?.auth) this._auth.socketOptions.auth.peerId = this._peerId;

    this._adapters = new Map();   // id → adapter instance
    this._listeners = new Map();  // event → Set<handler>
    this._buffer = [];            // pending control sends when no adapter ready
    this._pendingAcks = new Map(); // ackId → callback (RTC ack)
    this._ackTimers = new Map();  // ackId → timeout (zombie detection)
    this._ackSeq = 0;

    // RTC zombie recovery — restart with backoff when acks time out (dead-but-open DC)
    this._rtcRestartAttempts = 0;
    this._rtcRestartTimer = null;
    this._probeAttempts = 0;     // escalating-probe index (probeBackoffMs)
    this._rtcGivenUp = false;    // hard NAT detected → WS-only until network changes
    this._giveUpIp = null;       // public IP at give-up — re-arm only when it changes
    this._lastStunProbeAt = 0;   // rate-limit the standalone STUN probe
    // Debounce a WS-driven rejoin while RTC is mid-handshake (resume case) so the
    // terminal isn't reset right before RTC opens — cleared on RTC open / disconnect.
    this._rejoinDebounceTimer = null;
    // Public IP last seen via STUN — identity of the network we negotiated on.
    this._netFingerprint = null;
    // Set when the agent answers "not approved" — pauses RTC recovery until the
    // host acts, so we don't spin offers the agent will only refuse again.
    this._awaitingApproval = false;
    this._ackTimeoutMs = RTC_RESTART.ackTimeoutMs;

    // Resume-from-background probe state. OS suspends the tab → iceConnectionState
    // events deferred → RTC may report "open" while dead. Track when we went hidden
    // so the visibility handler can probe-then-restart instead of blind-restarting.
    this._hiddenAt = null;
    this._resumeProbeTimer = null;
    this._probeToken = 0;

    this._connected = false;
    this._type = "ws";
    this._connectionMode = "tunnel";
    this._lastWsState = null;

    // Persistent proxy socket — emit always routed through PM (auto fallback to RTC).
    // on/off delegate to current raw socket. Survives WS disconnect.
    this._rawSocket = null;
    this._proxySocket = this._createProxySocket();
    this.socketRef = { current: this._proxySocket };
    // onConnect fires once when the FIRST adapter opens (RTC or WS) so the app is
    // usable before the tunnel comes up. Without this, workspace hooks wait for WS
    // and fail with "Connection Failed" when the tunnel is slow/dead.
    this._onConnectFired = false;
    // Visibility-based RTC health check — restart frozen RTC when tab becomes visible.
    // WS may survive background suspension (socket.io keepalive) while the RTC
    // PeerConnection freezes/closes; without this, RTC never recovers on resume.
    this._visibilityHandler = () => {
      termLog("switch", `visibility=${document.visibilityState}`);
      if (document.visibilityState !== "visible") {
        if (document.visibilityState === "hidden") this._hiddenAt = Date.now();
        return;
      }
      const ws = this._adapters.get("ws");
      const rtc = this._adapters.get("rtc");
      termLog("switch", `resume check: ws=${ws?.ready ? "ready" : ws?.state} rtc=${rtc?.ready ? "ready" : rtc?.state}`);
      // WS zombie: socket.io still reports connected after background suspension
      // froze its pings, so it looks ready but no bytes flow (terminal/remote go
      // dead with NO disconnect modal, and only an app reload recovers). Break the
      // zombie socket so the normal reconnect path replaces it.
      // lastInboundAt comes from Engine.IO "pong" (true liveness, independent of
      // app traffic or RTC) so an idle-but-alive WS is never mistaken for a zombie.
      // Use the FRESHEST of pong and app-event: a carrier that still delivers app
      // bytes is alive even if the server's pingInterval is long/disabled, and an
      // idle socket is kept alive by pong. Only when BOTH go stale is it a zombie.
      const wsLastAlive = Math.max(ws?.lastInboundAt ?? 0, ws?.lastMsgAt ?? 0);
      const wsZombie = ws?.ready && isWsZombie({
        ready: true,
        lastInboundAt: wsLastAlive,
        now: Date.now()
      });
      // TEMP DIAGNOSTIC — compare pong liveness vs app-event liveness.
      // lastInbound = pong heartbeat; lastMsg = app event over WS. If lastMsg
      // stays fresh while lastInbound goes stale, pong stamping is the bug.
      if (ws) {
        const lb = ws.lastInboundAt ?? 0;
        const lm = ws.lastMsgAt ?? 0;
        const now = Date.now();
        termLog("switch", `zombie check: verdict=${!!wsZombie} ready=${!!ws.ready} lastPong=${lb ? `${now - lb}ms` : "never"} lastMsg=${lm ? `${now - lm}ms` : "never"}`);
      }
      if (wsZombie) {
        debugLog("transport", "[pm] ws zombie on resume → force reconnect");
        try { ws.forceReconnect?.(); } catch {}
      }
      // WS not ready but not a zombie → leave it alone. WsProtocol's own
      // visibility handler already calls _forceReconnect, and calling retryNow
      // here would kill a healthy mid-handshake socket on every tab focus →
      // onConnect → handleSocketReady → UI flash.
      // Signaling rides the tunnel WS *or* the DO relay — an RTC-only session
      // has no ws adapter at all, so gating on WS here left it stuck forever.
      if (this._awaitingApproval) return; // host hasn't approved yet — nothing to retry
      // Gave up on hard NAT → only a REAL network change can make RTC viable again.
      // Ask STUN for the current public IP (no DO call) and compare; a timer would
      // re-spam the DO on every long app switch even though the NAT never moved.
      if (this._rtcGivenUp) {
        // The probe decides asynchronously whether to re-arm; nothing else on the
        // resume path should touch RTC while we're WS-only.
        this._maybeRearmRtc();
        return;
      }
      if (!this._canSignal()) {
        // Both carriers down (background froze them too) — kick the relay and
        // let its onReady restart RTC once a path exists again.
        this._sig?.retryNow();
        return;
      }
      const rtcState = rtc?.state;
      if (!rtc || rtcState === ADAPTER_STATE.closed || rtcState === ADAPTER_STATE.degraded) {
        termLog("switch", `visibility → restartRtc (rtc=${rtcState || "absent"})`);
        this._restartRtc();
      } else {
        // RTC reports open/connecting — but OS suspension often kills the DC
        // without firing an iceConnectionState change. Probe the DC before
        // tearing down; only force a restart if the probe times out.
        this._probeRtcOnResume();
      }
    };
    document.addEventListener("visibilitychange", this._visibilityHandler);
    // Page Lifecycle: a tab returning from frozen→active may NOT fire
    // visibilitychange (Chrome 77+ Android) — only `resume`. Treat it the same.
    this._resumeHandler = () => {
      if (document.visibilityState === "visible") this._visibilityHandler();
    };
    this._freezeHandler = () => { this._hiddenAt = Date.now(); };
    document.addEventListener("resume", this._resumeHandler);
    document.addEventListener("freeze", this._freezeHandler);

    // Network handover (wifi ⇄ cellular ⇄ another AP) invalidates the NAT
    // bindings ICE negotiated, so RTC is dead well before its own timers notice.
    // Both signals are hints only (onLine is unreliable per MDN; the Network
    // Information API is missing on Safari) — the srflx check does the deciding.
    this._netHandler = () => {
      clearTimeout(this._netDebounceTimer);
      this._netDebounceTimer = setTimeout(() => {
        if (navigator.onLine === false) return; // still down — wait for "online"
        debugLog("transport", "[pm] network change → probe rtc");
        this._sig?.retryNow();
        // Fresh network deserves a fresh budget, else a session that burned its
        // 3 restarts on a bad network is locked to the tunnel forever. A network
        // change also means the NAT may differ → clear any give-up and try again.
        termLog("switch", `RESET attempts (was ${this._rtcRestartAttempts}) givenUp=${this._rtcGivenUp} reason=net-change`); // TEMP DIAGNOSTIC
        this._rtcRestartAttempts = 0;
        this._probeAttempts = 0;
        this._rtcGivenUp = false;
        this._giveUpIp = null;
        // No carrier yet — the relay just reconnected; its onReady fires the
        // restart. Renegotiating now would only buffer an offer nobody reads.
        if (this._shouldRenegotiate()) this._restartRtc();
      }, NET_RECOVERY.debounceMs);
    };
    window.addEventListener("online", this._netHandler);
    navigator.connection?.addEventListener?.("change", this._netHandler);

    // Cross-adapter signaling — RTC pulls this from connect ctx
    this._rtcSignalingHandler = null;
    // DO signaling relay (fallback carrier). Lazy-init in connect() once deviceId is known.
    this._sig = null;
    this._sigDestroyed = false;
    // Outbound signaling that arrived before any carrier was ready (RTC created
    // its offer before the tunnel WS or DO relay finished connecting). Flushed
    // the moment either carrier opens.
    this._sigBuffer = [];
    this._wsFallbackTimer = null;
  }

  _createProxySocket() {
    const pm = this;
    // Tracks listeners registered via proxy.on — PM uses this to:
    //   1) Re-attach to new raw socket after reconnect
    //   2) Manually invoke when RTC dispatches event (raw socket may be down)
    const proxyListeners = new Map(); // event → Set<handler>

    return {
      _proxyListeners: proxyListeners,
      get connected() { return pm._anyAdapterReady(); },
      get id() { return pm._rawSocket?.id || null; },
      emit(event, ...args) {
        pm._sendControl(event, args);
      },
      on(event, handler) {
        if (!proxyListeners.has(event)) proxyListeners.set(event, new Set());
        proxyListeners.get(event).add(handler);
        pm._rawSocket?.on(event, handler);
      },
      off(event, handler) {
        proxyListeners.get(event)?.delete(handler);
        pm._rawSocket?.off(event, handler);
      },
      once(event, handler) {
        // Track via proxyListeners so RTC dispatch invokes it even before the
        // raw socket is bound (RTC-first). fired guard prevents double fire.
        let fired = false;
        const wrapper = (...args) => {
          if (fired) return;
          fired = true;
          proxyListeners.get(event)?.delete(wrapper);
          pm._rawSocket?.off(event, wrapper);
          try { handler(...args); } catch {}
        };
        if (!proxyListeners.has(event)) proxyListeners.set(event, new Set());
        proxyListeners.get(event).add(wrapper);
        pm._rawSocket?.on(event, wrapper);
      },
      listeners(event) {
        return [...(proxyListeners.get(event) || [])];
      },
      disconnect() {
        pm._rawSocket?.disconnect();
      }
    };
  }

  /** Re-attach all proxy listeners to a fresh raw socket after reconnect. */
  _rebindProxyListeners() {
    if (!this._rawSocket || !this._proxySocket?._proxyListeners) return;
    for (const [event, set] of this._proxySocket._proxyListeners.entries()) {
      for (const h of set) this._rawSocket.on(event, h);
    }
  }

  get type() { return this._type; }
  get connected() { return this._connected; }
  get connectionMode() { return this._connectionMode; }
  get wsBlocked() { return this._adapters.get("ws")?.blocked || false; }

  /** Dev/test: block WS reconnect to verify RTC standalone behavior. */
  setWsBlocked(blocked) {
    this._adapters.get("ws")?.setBlocked(blocked);
  }

  /** Widen WS retry window while agent self-updates. */
  setUpdating(updating) {
    this._adapters.get("ws")?.setUpdating(updating);
  }

  /** User-triggered immediate reconnect — skips backoff and revives a failed adapter. */
  retryNow() {
    const ws = this._adapters.get("ws");
    if (ws) { ws.retryNow?.(); return; }
    // Adapter was torn down (PM.disconnect) — rebuild from scratch
    this.connect();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  /** Legacy emit — routes through control channel via best adapter. */
  emit(event, ...args) {
    this._sendControl(event, args);
  }

  /**
   * Send a binary payload on a channel (file transfer). Picks the best adapter
   * (RTC preferred), falls back to WS on RTC backpressure/death — same pattern
   * as _sendControl. Returns true if delivered on any adapter.
   */
  sendBinary(channel, payload) {
    const adapter = this._pickAdapter(channel);
    if (!adapter) return false;
    return adapter.send(channel, payload);
  }

  connect() {
    // RTC + WS in parallel: RTC is the preferred carrier (P2P, low latency); the
    // WS tunnel stays warm as an instant-switch standby. Data routing still prefers
    // RTC via _pickAdapter, so WS is near-idle when RTC is healthy — but always
    // ready, making a carrier switch 0ms (no spawn-on-failure delay → no flicker).
    this._sigDestroyed = false;
    this._initSignalingClient();
    this._startSecondaryAdapters();
    this._startWsFallback();
    debugLog("transport", "[pm] connect: RTC + WS parallel (RTC preferred, WS warm standby).");
    termLog("switch", "connect: RTC + WS parallel");
  }

  // Bring up the WS tunnel adapter (parallel standby or fallback after RTC death).
  async _startWsFallback() {
    if (this._adapters.has("ws") || this._sigDestroyed) return;
    termLog("switch", "ws-fallback: start (refresh url)");
    // The cached tunnelUrl may be stale (cloudflared restarted → new trycloudflare
    // URL). Re-fetch the latest from the Worker before connecting.
    await this._refreshTunnelUrl();
    // Re-check after await: disconnect() may have run, or a concurrent call may
    // have already attached ws while the fetch was in flight.
    if (this._adapters.has("ws") || this._sigDestroyed) {
      termLog("switch", "ws-fallback: aborted (destroyed or already attached)");
      return;
    }
    termLog("switch", "ws-fallback: connecting");
    this._instantiate("ws");
    this._adapters.get("ws")?.connect(this._buildCtx("ws"));
  }

  async _refreshTunnelUrl() {
    try {
      debugLog("transport", `[pm] refreshTunnelUrl: fetching from ${WORKER_API}/api/connect`);
      const res = await fetch(`${WORKER_API}/api/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: this._auth.apiKey }),
      });
      if (!res.ok) {
        debugLog("transport", `[pm] refreshTunnelUrl: HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      debugLog("transport", `[pm] refreshTunnelUrl: got ${data.tunnelUrl} (was ${this._auth.tunnelUrl})`);
      if (data.tunnelUrl && data.tunnelUrl !== this._auth.tunnelUrl) {
        this._auth.tunnelUrl = data.tunnelUrl;
      }
    } catch (e) {
      debugLog("transport", `[pm] refreshTunnelUrl: error ${e.message}`);
    }
  }

  _initSignalingClient() {
    if (!SIGNALING_CONFIG.enabled || this._sig || this._sigDestroyed) return;
    if (!this._auth.deviceId || !this._auth.apiKey) return;
    // DO endpoint follows WORKER_API (env override → localhost UI talks to deployed DO).
    const doUrl = WORKER_API.replace(/^http/, "ws") + "/signaling";
    import("./SignalingClient").then(({ SignalingClient }) => {
      // Guard: disconnect may have run while the dynamic import was pending.
      if (this._sig || this._sigDestroyed) return;
      this._sig = new SignalingClient({
        url: doUrl,
        role: "client",
        roomId: this._auth.apiKey,
        apiKey: this._auth.apiKey,
        from: this._peerId,
        onReady: () => this._onSignalingReady(),
        pingMs: SIGNALING_CONFIG.pingMs
      });
      this._sig.on((msg) => {
        // Agent test-toggle: RTC refused. Stop retrying so the client stays on WS
        // instead of looping offer→refuse→close→restart. Cleared by reload.
        if (msg.type === "error" && msg.message === "rtc-disabled") {
          this._rtcTestDisabled = true;
          termLog("switch", "rtc-disabled by agent → stop RTC retry (use WS)");
          return;
        }
        if (this._handleApprovalSignal(msg)) return;
        this._rtcSignalingHandler?.(msg);
      });
      this._sig.connect();
    }).catch((err) => debugLog("transport", `[pm] SignalingClient load failed: ${err?.message || err}`));
  }

  _instantiate(id) {
    if (this._adapters.has(id)) return;
    const Adapter = getProtocol(id);
    if (!Adapter) return;
    const inst = new Adapter();
    inst.on("stateChange", (state) => this._onAdapterStateChange(id, state));
    inst.on("message", ({ event, data, source }) => this._dispatch(event, data, source));
    inst.on("binary", (msg) => this._onBinary(msg));
    if (id === "rtc") inst.on("netFingerprint", (ip) => this._onNetFingerprint(ip));
    this._adapters.set(id, inst);
  }

  /** STUN reported a different public egress IP. We do NOT reset the restart
   * budget here anymore: dual-stack ISPs and carrier NAT pools make the IP
   * flip-flop between IPv4/IPv6 and neighbours of the SAME network, which fired
   * a false "network changed" on every restart and pinned RTC to the shortest
   * backoff forever. A real network handover is detected via the browser's
   * online/connection events (and resets the budget there); RTC OPEN itself
   * also resets. This handler now only records the fingerprint for telemetry. */
  _onNetFingerprint(ip) {
    if (!ip || ip === this._netFingerprint) return;
    const prev = this._netFingerprint;
    this._netFingerprint = ip;
    if (!prev) return; // first gather of the session — nothing changed yet
    debugLog("transport", `[pm] net fingerprint ${prev}→${ip} (same network — no backoff reset)`);
  }

  /** Lift an RTC give-up only on evidence: a STUN probe (public STUN, no DO call,
   *  no agent) reporting a public IP different from the one we gave up on. Same
   *  IP → the NAT that refused P2P is still there, so stay WS-only and spend
   *  nothing. Rate-limited: resume/visibility can fire in bursts. */
  _maybeRearmRtc() {
    if (!this._rtcGivenUp) return;
    const now = Date.now();
    if (now - this._lastStunProbeAt < STUN_PROBE.minIntervalMs) return;
    this._lastStunProbeAt = now;
    probePublicIp().then((raw) => {
      // The probe takes seconds — the PM may have been torn down meanwhile.
      // Resurrecting RTC on a disconnected PM would leak a peer nobody owns.
      if (this._sigDestroyed) return;
      if (!this._rtcGivenUp) return; // something else already re-armed us
      // Compare like for like: a STUN-blocked network reports NO_PUBLIC_IP on both
      // sides, so it reads as "unchanged" instead of re-arming on every resume.
      const ip = raw || (this._giveUpIp === NO_PUBLIC_IP ? NO_PUBLIC_IP : null);
      if (!shouldRearmOnIpChange(this._giveUpIp, ip)) {
        termLog("switch", `rearm check: ip=${ip || "unknown"} same as give-up → stay WS-only`);
        return;
      }
      termLog("switch", `rearm check: ip ${this._giveUpIp || "unknown"}→${ip} changed → re-arm RTC`);
      debugLog("transport", `[pm] public ip changed → re-arm rtc`);
      this._rtcGivenUp = false;
      this._giveUpIp = null;
      this._probeAttempts = 0;
      this._rtcRestartAttempts = 0;
      this._netFingerprint = raw;
      // Relay may be down (we skipped its retry while WS-only) — kick it and let
      // _onSignalingReady fire the restart once a signaling path exists again.
      if (!this._canSignal()) { this._sig?.retryNow(); return; }
      if (this._shouldRenegotiate()) this._restartRtc();
    }).catch(() => {});
  }

  _startSecondaryAdapters() {
    debugLog("transport", `[pm] startSecondary enabled=${this._profile.enabled}`);
    debugLog("transport", `[pm] startSecondary rtcTestDisabled=${!!this._rtcTestDisabled}`);
    for (const id of this._profile.enabled) {
      if (id === "ws") continue;
      if (id === "rtc" && this._rtcTestDisabled) continue; // agent test-toggle
      if (this._adapters.has(id)) continue;
      debugLog("transport", `[pm] start adapter ${id}`);
      this._instantiate(id);
      this._adapters.get(id)?.connect(this._buildCtx(id));
    }
  }

  /** The agent answered "not approved" rather than failing to connect. Surface it
   * as approval UI and stop renegotiating — retrying can't change a policy answer,
   * and letting it reach the RTC adapter would tear the peer down and fall back to
   * the tunnel, hiding the approval screen behind a connection error.
   * @returns {boolean} true when handled (caller must not forward the message) */
  _handleApprovalSignal(msg) {
    if (msg?.type !== "error") return false;
    const status = msg.message === SIGNALING_ERRORS.pending ? "pending"
      : msg.message === SIGNALING_ERRORS.rejected ? "rejected"
      : null;
    if (!status) return false;
    debugLog("transport", `[pm] device ${status} → approval UI`);
    this._awaitingApproval = true;
    this._wsCallbacks.onApproval?.(status);
    return true;
  }

  /** Relay (re)connected — drain queued signaling, and renegotiate if RTC died
   * while we had no carrier (resume from background, network handover). */
  _onSignalingReady() {
    termLog("switch", "signaling ready");
    this._flushSigBuffer();
    if (this._awaitingApproval) return; // policy answer pending — a re-offer changes nothing
    // First connect already has RTC negotiating — only step in once it's dead.
    const rtc = this._adapters.get("rtc");
    if (rtc && rtc.state === ADAPTER_STATE.closed) {
      termLog("switch", "sig-ready → restartRtc (rtc was closed)");
      this._restartRtc();
    }
  }

  /** Can a fresh offer/answer reach the agent? DO is the sole signaling carrier. */
  _canSignal() {
    return !!this._sig?.ready;
  }

  /** Waiting on the host to approve this device — a new offer would just be
   * refused again, so recovery paths stand down until approval arrives. */
  _shouldRenegotiate() {
    return !this._awaitingApproval && this._canSignal();
  }

  /** Tear down RTC + renegotiate via new WS socket (called on WS reconnect). */
  _restartRtc() {
    // TEMP DIAGNOSTIC
    termLog("switch", `restartRtc CALLED by=${callerTrace()} attempts=${this._rtcRestartAttempts}`);
    if (this._rtcTestDisabled) {
      termLog("switch", "restartRtc skipped (rtcTestDisabled)");
      return;
    }
    // Hard NAT → every recovery path (visibility, sig-ready, net handler) must
    // stand down too, or the give-up only stops the probe timer while the others
    // keep spending DO calls.
    if (this._rtcGivenUp) {
      termLog("switch", "restartRtc skipped (hard NAT → WS-only)");
      return;
    }
    const rtc = this._adapters.get("rtc");
    // Another recovery path (visibility, signaling-ready, net handler) already
    // spun up a new peer — don't kill it mid-handshake. Only restart dead/idle.
    if (rtc && (rtc.state === ADAPTER_STATE.connecting || rtc.state === ADAPTER_STATE.open)) {
      termLog("switch", `restartRtc skipped (rtc=${rtc.state})`);
      return;
    }
    if (!rtc) { termLog("switch", "restartRtc: no rtc → startSecondary"); this._startSecondaryAdapters(); return; }
    termLog("switch", "restartRtc: tear down + renegotiate");
    debugLog("transport", "[pm] ws reconnected → restart rtc");
    try { rtc.disconnect(); } catch {}
    this._adapters.delete("rtc");
    this._rtcSignalingHandler = null;
    this._startSecondaryAdapters();
  }

  /** Force restart bypassing the open/connecting guard — used when the resume
   * probe confirms the DC is dead despite rtc.state reporting "open". */
  _forceRestartRtc() {
    termLog("switch", `forceRestartRtc CALLED by=${callerTrace()}`);
    const rtc = this._adapters.get("rtc");
    if (rtc) {
      try { rtc.disconnect(); } catch {}
      this._adapters.delete("rtc");
      this._rtcSignalingHandler = null;
    }
    // Hard NAT → tear the dead peer down but don't negotiate a new one; that
    // would spend a DO round-trip the same NAT will refuse again.
    if (this._rtcGivenUp) {
      termLog("switch", "forceRestartRtc: torn down, no renegotiate (hard NAT)");
      return;
    }
    this._startSecondaryAdapters();
  }

  /** On resume from background, RTC may report "open" while the DC is actually
   *  dead (OS suspension froze ICE without firing state changes). Sample
   *  getStats() across the window — STUN keepalives grow responsesReceived on a
   *  live DC; a flat counter means zombie → force a restart. Browser-only, no
   *  agent cooperation (and no DO signaling round-trip on a healthy resume). */
  _probeRtcOnResume() {
    const rtc = this._adapters.get("rtc");
    if (!rtc?.ready) { this._restartRtc(); return; }
    const pc = rtc._pc;
    if (!pc || pc.connectionState === "failed") { this._forceRestartRtc(); return; }
    // Browser-only probe (no agent cooperation): sample the selected ICE
    // candidate-pair's responsesReceived across the window. ICE sends STUN
    // keepalives continuously — even with no app traffic — so a live DC grows
    // this counter; a frozen/zombie DC stays flat. Avoids a DO round-trip per
    // resume and needs no new agent event.
    clearTimeout(this._resumeProbeTimer);
    const token = ++this._probeToken;
    const sample = async () => {
      const r1 = await pc.getStats();
      const a = selectedIceResponses(r1);
      if (a == null) return null;
      await new Promise((res) => { this._resumeProbeTimer = setTimeout(res, RESUME_PROBE_TIMEOUT_MS); });
      if (token !== this._probeToken) return null; // superseded / disconnected
      const r2 = await pc.getStats();
      return selectedIceResponses(r2) - a;
    };
    sample().then((delta) => {
      if (token !== this._probeToken) return;
      if (delta != null && delta > 0) {
        termLog("switch", `resume probe getStats alive (Δ=${delta})`);
        debugLog("transport", `[pm] resume probe alive (delta=${delta})`);
      } else {
        termLog("switch", `resume probe getStats dead (Δ=${delta}) → forceRestartRtc`);
        debugLog("transport", `[pm] resume probe dead (delta=${delta}) → restart rtc`);
        this._forceRestartRtc();
      }
    }).catch(() => {
      if (token !== this._probeToken) return;
      termLog("switch", "resume probe getStats error → forceRestartRtc");
      this._forceRestartRtc();
    });
  }

  disconnect() {
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._resumeHandler) {
      document.removeEventListener("resume", this._resumeHandler);
      this._resumeHandler = null;
    }
    if (this._freezeHandler) {
      document.removeEventListener("freeze", this._freezeHandler);
      this._freezeHandler = null;
    }
    clearTimeout(this._resumeProbeTimer);
    this._resumeProbeTimer = null;
    this._probeToken++; // invalidate any in-flight getStats probe
    if (this._netHandler) {
      window.removeEventListener("online", this._netHandler);
      navigator.connection?.removeEventListener?.("change", this._netHandler);
      this._netHandler = null;
    }
    clearTimeout(this._netDebounceTimer);
    this._netDebounceTimer = null;
    try { this._sig?.disconnect(); } catch {}
    this._sig = null;
    this._sigDestroyed = true;
    this._sigBuffer = [];
    clearTimeout(this._wsFallbackTimer);
    clearTimeout(this._rejoinDebounceTimer);
    this._rejoinDebounceTimer = null;
    for (const inst of this._adapters.values()) {
      try { inst.disconnect(); } catch {}
    }
    this._adapters.clear();
    this._listeners.clear();
    this._buffer = [];
    this._connected = false;
    this._rawSocket = null;
    // Clear RTC zombie recovery state
    clearTimeout(this._rtcRestartTimer);
    this._rtcRestartTimer = null;
    termLog("switch", `RESET attempts (was ${this._rtcRestartAttempts}) reason=pm-disconnect`); // TEMP DIAGNOSTIC
    this._rtcRestartAttempts = 0;
    this._probeAttempts = 0;
    this._rtcGivenUp = false;
    this._giveUpIp = null;
    this._lastStunProbeAt = 0;
    for (const t of this._ackTimers.values()) clearTimeout(t);
    this._ackTimers.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _buildCtx(adapterId, _inst) {
    const ctx = {
      auth: this._auth,
      profile: this._profile
    };
    if (adapterId === "ws") {
      ctx.onRetryStatus = this._wsCallbacks.onRetryStatus;
      ctx.onUrlUpdate = (upd) => {
        if (upd.tunnelUrl) this._auth.tunnelUrl = upd.tunnelUrl;
        if (upd.localIp !== undefined) this._auth.localIp = upd.localIp;
        this._wsCallbacks.onUrlUpdate?.(upd);
      };
    }
    if (adapterId === "rtc") {
      ctx.signaling = {
        send: (msg) => this._sendSignaling(msg),
        on: (handler) => { this._rtcSignalingHandler = handler; },
        off: () => { this._rtcSignalingHandler = null; }
      };
    }
    return ctx;
  }

  _onAdapterStateChange(adapterId, state) {
    debugLog("transport", `[pm] ${adapterId} state=${state}`);
    // The adapter already logs its own transition with a reason — repeating it
    // here doubles every line, so only log states adapters don't announce.
    if (!(adapterId === "rtc" && state === ADAPTER_STATE.closed)) {
      termLog("switch", `${adapterId}→${state}`);
    }

    if (adapterId === "ws") {
      const ws = this._adapters.get("ws");
      if (state === ADAPTER_STATE.open) {
        const isReconnect = this._lastWsState === ADAPTER_STATE.degraded;
        this._connected = true;
        this._connectionMode = ws?.connectionMode || "tunnel";
        this._rawSocket = ws?.socket || null;
        // Re-attach proxy listeners to new raw socket
        this._rebindProxyListeners();
        // On WS reconnect (resume from background), the new socket is already
        // connected by the time we bind "connect" handlers — Socket.IO won't fire
        // the event again. Manually notify so terminal panes rejoin for fresh
        // scrollback.
        if (isReconnect) {
          this._maybeFireRejoin("ws", "ws reconnect while rtc ready");
        }
        if (this._lastWsState !== ADAPTER_STATE.open) {
          // First WS open after RTC already fired onConnect → just note the tunnel
          // is up (mode/transport update); don't re-fire onConnect (handlers would
          // double-register listeners on the proxy).
          if (this._onConnectFired) {
            this._wsCallbacks.onUrlUpdate?.({});
          } else {
            this._onConnectFired = true;
            termLog("switch", `onConnect FIRE (ws, mode=${this._connectionMode})`);
            // Pass proxy socket so consumer's onConnect handlers register listeners on PROXY
            // (which auto re-binds to new raw socket after reconnect)
            this._wsCallbacks.onConnect?.(this._proxySocket, this._connectionMode);
          }
        }
        // RTC is started from connect() (signaling via DO, independent of WS).
        // WS reconnect no longer needs to renegotiate RTC — the DO relay carries
        // signaling without the tunnel.
      } else if (this._lastWsState === ADAPTER_STATE.open) {
        this._rawSocket = null;
        termLog("switch", "ws down");
        // Only signal disconnect if NO other adapter is keeping connection alive
        if (!this._anyAdapterReady()) {
          this._onConnectFired = false;
          termLog("switch", "onDisconnect FIRE (no adapter ready)");
          this._wsCallbacks.onDisconnect?.(state);
        } else {
          debugLog("transport", "[pm] ws down but rtc alive → skip onDisconnect");
          termLog("switch", "ws down but rtc alive → skip onDisconnect");
        }
      }
      this._lastWsState = state;
    }

    if (adapterId === "rtc" && state === ADAPTER_STATE.open) {
      const isRtcReconnect = this._onConnectFired;
      clearTimeout(this._wsFallbackTimer);
      this._rtcCallbacks.onUpgrade?.(this._adapters.get("rtc")?.typeDetail || "dc-stun");
      // RTC opened first (tunnel not up yet) — fire onConnect so workspace hooks
      // get the proxy socket and stop waiting for the tunnel. Data rides RTC.
      if (!this._onConnectFired) {
        this._onConnectFired = true;
        this._connected = true;
        this._connectionMode = "webrtc";
        termLog("switch", "onConnect FIRE (rtc, mode=webrtc)");
        this._wsCallbacks.onConnect?.(this._proxySocket, this._connectionMode);
      }
      // Successful RTC open → reset zombie recovery attempts + probe cadence
      termLog("switch", `RESET attempts (was ${this._rtcRestartAttempts}) reason=rtc-open`); // TEMP DIAGNOSTIC
      this._rtcRestartAttempts = 0;
      this._probeAttempts = 0;
      this._rtcGivenUp = false;
      this._giveUpIp = null;
      clearTimeout(this._rtcRestartTimer);
      this._rtcRestartTimer = null;
      // RTC opened → cancel any pending WS-rejoin debounce: the switch is transparent,
      // no need to reset the terminal.
      clearTimeout(this._rejoinDebounceTimer);
      this._rejoinDebounceTimer = null;
      // On RTC reconnect (resume from background/mobility), fire "connect" on the
      // proxy so terminal panes rejoin and fetch fresh scrollback. The proxy was
      // already bound during first open — this just re-notifies listeners the
      // transport is ready again (mirrors WS reconnect path).
      if (isRtcReconnect) {
        this._maybeFireRejoin("rtc", "rtc reconnect while ws ready");
      }
    }
    if (adapterId === "rtc" && state === ADAPTER_STATE.closed) {
      this._rtcCallbacks.onFallback?.("ws");
      termLog("switch", "rtc closed → startWsFallback + scheduleRtcRestart");
      // RTC down → bring up the WS tunnel now so there's a data path while RTC
      // retries via DO. If RTC comes back, _pickAdapter prefers it again.
      this._startWsFallback();
      clearTimeout(this._wsFallbackTimer);
      // Reject acks of requests sent over the now-dead RTC DC so callers fail
      // fast instead of hanging until the 30s cleanup silently drops them.
      for (const cb of this._pendingAcks.values()) {
        try { cb({ error: "rtc-closed" }); } catch {}
      }
      this._pendingAcks.clear();
      for (const t of this._ackTimers.values()) clearTimeout(t);
      this._ackTimers.clear();
      // RTC died → retry RTC via DO signaling (STUN again). Only after maxAttempts
      // of repeated failure does the tunnel (ws) own the session permanently.
      this._scheduleRtcRestart();
      // RTC died — if WS also down, emit disconnect now (was suppressed earlier)
      if (!this._anyAdapterReady()) {
        // All adapters down → next "ready" should fire onConnect again.
        this._onConnectFired = false;
        this._wsCallbacks.onDisconnect?.("rtc-closed");
      }
    }

    this._recomputeType();
    this._connected = this._anyAdapterReady();
    this._flushBuffer();
  }

  /** Fire the proxy "connect" rejoin on a carrier reconnect — UNLESS the other
   * carrier is already carrying data, in which case this is a transparent switch
   * and terminal panes must not reset+reload. Only the first adapter up after a
   * full outage triggers the rejoin.
   *
   * Debounce: if WS reconnects while RTC is still connecting (typical after resume
   * — WS via tunnel is faster than RTC ICE gather), wait briefly for RTC. If RTC
   * opens, the switch is transparent (skip rejoin, no flicker). If RTC fails, the
   * debounce fires the rejoin so content recovers via WS. */
  _maybeFireRejoin(adapterId, reason) {
    const other = adapterId === "ws" ? this._adapters.get("rtc") : this._adapters.get("ws");
    if (other?.ready) {
      debugLog("transport", `[pm] ${reason} → skip rejoin (other ready)`);
      termLog("switch", `${reason} → skip rejoin (other ready)`);
      return;
    }
    // WS just reconnected but RTC is mid-handshake — debounce instead of resetting
    // the terminal; RTC usually opens within ~500ms and the switch stays invisible.
    if (adapterId === "ws" && other && other.state === ADAPTER_STATE.connecting) {
      debugLog("transport", `[pm] ${reason} → debounce rejoin (rtc connecting)`);
      termLog("switch", `${reason} → debounce rejoin ${REJOIN_DEBOUNCE_MS}ms (rtc connecting)`);
      clearTimeout(this._rejoinDebounceTimer);
      this._rejoinDebounceTimer = setTimeout(() => {
        this._rejoinDebounceTimer = null;
        const r = this._adapters.get("rtc");
        if (r?.ready) {
          termLog("switch", "debounce: rtc opened → skip rejoin");
          return;
        }
        termLog("switch", `debounce expired → FIRE rejoin (rtc=${r?.state || "absent"})`);
        for (const h of this._proxySocket?._proxyListeners?.get("connect") || []) {
          try { h(); } catch {}
        }
      }, REJOIN_DEBOUNCE_MS);
      return;
    }
    termLog("switch", `${reason} → FIRE rejoin`);
    for (const h of this._proxySocket?._proxyListeners?.get("connect") || []) {
      try { h(); } catch {}
    }
  }

  _recomputeType() {
    // type follows binary channel preference (legacy behavior)
    const adapter = this._pickAdapter(CHANNELS.binary) || this._pickAdapter(CHANNELS.control);
    const next = !adapter ? "ws"
      : adapter.constructor.id === "rtc" ? (adapter.typeDetail || "dc-stun")
      : "ws";
    if (next !== this._type) {
      this._type = next;
      this._rtcCallbacks.onTransportChange?.(next);
    }
  }

  _anyAdapterReady() {
    for (const a of this._adapters.values()) if (a.ready) return true;
    return false;
  }

  _pickAdapter(channel) {
    const cfg = this._profile.channels[channel];
    if (!cfg) return null;

    const candidates = [...this._adapters.values()]
      .filter((a) => a.supports(channel) && a.ready);

    if (cfg.prefer) {
      const preferred = candidates.find((a) => a.constructor.id === cfg.prefer);
      if (preferred) return preferred;
    }
    candidates.sort((a, b) =>
      (b.constructor.priority[channel] ?? 0) - (a.constructor.priority[channel] ?? 0)
    );
    return candidates[0] || null;
  }

  /**
   * Send control event with multi-arg + optional callback (last fn arg = ack).
   * WS adapter uses socket.io native multi-arg/ack; RTC uses {event, args, ackId} envelope.
   */
  _sendControl(event, args) {
    const last = args[args.length - 1];
    const cb = typeof last === "function" ? args.pop() : null;
    let adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) {
      debugLog("transport", `[pm] buffer event=${event} (no adapter ready)`);
      termLog("switch", `buffer "${event}" (no adapter)`);
      this._buffer.push({ event, args, cb });
      return;
    }
    // Preemptive size-routing: SCTP DC rejects oversize control payloads (> CONTROL_RTC_MAX_BYTES)
    // with a throw/false, corrupting the channel into a zombie state. Route oversize payloads
    // to WS (no SCTP limit) before attempting RTC.
    if (adapter.constructor.id === "rtc" && _controlBytes(args) > CONTROL_RTC_MAX_BYTES) {
      const ws = this._adapters.get("ws");
      if (ws?.ready) adapter = ws;
    }
    debugLog("transport", `[pm] send control event=${event} via=${adapter.constructor.id}`);
    if (adapter.constructor.id === "rtc") {
      let ackId = null;
      if (cb) {
        ackId = `c_${++this._ackSeq}`;
        this._pendingAcks.set(ackId, cb);
        // Short timeout — zombie RTC (open but bytes lost) means ack never arrives.
        // On expiry, trigger restart instead of waiting the full 30s.
        this._scheduleAckTimeout(ackId);
      }
      const ok = adapter.send(CHANNELS.control, { event, args, ackId });
      // RTC DC silently dropped (dead SCTP / oversize slipped through) → fallback WS so
      // the request doesn't hang. Mirrors agent _sendControl fallback.
      if (!ok) {
        const ws = this._adapters.get("ws");
        if (ws?.ready) {
          if (cb) ws.send(CHANNELS.control, { event, args, cb });
          else ws.send(CHANNELS.control, { event, args });
        }
      }
    } else {
      // WS path — pass through to socket.io native (multi-arg + ack supported)
      adapter.send(CHANNELS.control, { event, args, cb });
    }
  }

  _flushBuffer() {
    if (!this._buffer.length) return;
    const adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) return;
    debugLog("transport", `[pm] flush ${this._buffer.length} buffered via=${adapter.constructor.id}`);
    while (this._buffer.length) {
      const { event, args, cb } = this._buffer.shift();
      const argsWithCb = cb ? [...args, cb] : args;
      this._sendControl(event, argsWithCb);
    }
  }

  /**
   * Dispatch incoming message. RTC payloads carry {args} array; WS payloads carry {data}
   * (legacy single-arg from raw socket.io onAny).
   */
  _dispatch(event, payload, source) {
    // Resolve ack reply — may arrive via RTC or WS (agent falls back to WS when RTC dies)
    if (event === "__ack") {
      const { ackId, args } = payload || {};
      const cb = this._pendingAcks.get(ackId);
      if (cb) {
        this._pendingAcks.delete(ackId);
        const t = this._ackTimers.get(ackId);
        if (t) { clearTimeout(t); this._ackTimers.delete(ackId); }
        cb(...(args || []));
      }
      return;
    }
    // Host approved (from either carrier) → recovery paths may renegotiate again.
    // If ICE timed out while waiting (host took >30s), the peer is gone — the
    // agent's buffered answer can't revive it, so renegotiate a fresh offer.
    if (event === "device:approved") {
      this._awaitingApproval = false;
      const rtc = this._adapters.get("rtc");
      if (this._canSignal() && (!rtc || rtc.state === ADAPTER_STATE.closed)) {
        this._restartRtc();
      }
    }
    // Agent test-toggle re-enabled RTC → clear the stop-retry flag and renegotiate.
    if (event === "rtc:enabled") {
      if (this._rtcTestDisabled) {
        this._rtcTestDisabled = false;
        termLog("switch", "rtc:enabled by agent → clear flag + restart RTC");
        this._restartRtc();
      }
      return;
    }
    // RTC control envelope carries {event, args}; binary path (tiles-data) keeps raw data
    const args = source === "rtc" && Array.isArray(payload?.args)
      ? payload.args
      : [payload];
    // 1) PM bus listeners
    const set = this._listeners.get(event);
    if (set) for (const h of set) h(...args);
    // 2) Forward to raw socket listeners ONLY if not from WS (WS source: socket.io already
    // invoked native listeners; forwarding would double-fire).
    if (source === "ws") return;
    const sock = this.socketRef.current;
    if (!sock) return;
    const fns = sock.listeners?.(event);
    if (fns?.length) for (const fn of fns) fn(...args);
  }

  /**
   * Incoming binary frame from an adapter's "binary" event (RTC DC "file").
   * Route to socket.io-style "file-bin" listeners so WS and RTC paths share one
   * handler (WS delivers "file-bin" natively via socket.io onAny).
   */
  _onBinary(msg) {
    if (!msg || msg.channel !== "file") return;
    const sock = this.socketRef.current;
    if (!sock) return;
    const fns = sock.listeners?.("file-bin");
    if (fns?.length) for (const fn of fns) fn(msg.buffer);
  }

  // ─── RTC zombie recovery ───────────────────────────────────────────────────

  // Short ack timeout — if ack doesn't arrive, RTC is likely zombie (open but bytes lost).
  _scheduleAckTimeout(ackId) {
    const timer = setTimeout(() => {
      this._ackTimers.delete(ackId);
      debugLog("transport", `[pm] ack timeout ackId=${ackId} → suspect zombie RTC`);
      this._scheduleRtcRestart();
    }, this._ackTimeoutMs);
    this._ackTimers.set(ackId, timer);
  }

  // Two-phase RTC recovery: fast backoff (1s/2s/4s) right after failure, then a
  // slow probe (30s) that keeps trying P2P while the tunnel carries data. Never
  // gives up — network conditions improve, and a cheap STUN probe every 30s is
  // negligible next to tunnel bandwidth. Reset-on-open and net-change restore the
  // fast phase. DO-down skips the probe (_onSignalingReady restarts when it's back).
  _scheduleRtcRestart() {
    // TEMP DIAGNOSTIC — value before ++ reveals if a reset happened between cycles
    termLog("switch", `scheduleRtcRestart ENTER attempts=${this._rtcRestartAttempts} probeAttempts=${this._probeAttempts} givenUp=${this._rtcGivenUp}`);
    // Hard NAT (symmetric / STUN-blocked, no TURN) → P2P can't succeed, stop
    // spending DO signaling calls. Re-armed by network change / visibility resume.
    if (this._rtcGivenUp) {
      termLog("switch", "scheduleRtcRestart skipped (hard NAT → WS-only)");
      debugLog("transport", "[pm] rtc probe skipped (given up — hard NAT)");
      return;
    }
    const attempt = this._rtcRestartAttempts;
    const isProbe = attempt >= RTC_RESTART.maxAttempts;
    let delay;
    if (isProbe) {
      delay = RTC_RESTART.probeBackoffMs[this._probeAttempts] ?? RTC_RESTART.probeBackoffMs.at(-1);
      this._probeAttempts++;
      // After enough failed probes, classify the NAT. "hard" → give up (WS-only).
      // Soft/unknown → reset the probe cadence so one bad stretch doesn't lock us
      // at the 5-min cap forever.
      if (this._probeAttempts >= RTC_RESTART.classifyAfterProbes) {
        const rtc = this._adapters.get("rtc");
        const verdict = rtc?.natVerdict?.() ?? "unknown";
        termLog("switch", `scheduleRtcRestart natVerdict=${verdict} probeAttempts=${this._probeAttempts}`);
        debugLog("transport", `[pm] rtc nat verdict=${verdict} after ${this._probeAttempts} probes`);
        if (verdict === "hard") {
          this._rtcGivenUp = true;
          // Remember the network we gave up on — a resume only re-arms RTC when
          // the public IP differs (evidence of a real handover, not a timer).
          this._giveUpIp = this._netFingerprint;
          if (!this._giveUpIp) {
            // The peer gathered no srflx (UDP blocked), so we have no baseline.
            // Take one from the standalone probe — the same source the resume
            // check uses — else every resume would compare against null, read it
            // as "changed", and re-enter the ladder forever. A probe that also
            // finds no public IP records NO_PUBLIC_IP so the baseline is still
            // stable on STUN-blocked networks.
            probePublicIp().then((ip) => {
              if (this._rtcGivenUp && !this._giveUpIp) {
                this._giveUpIp = ip || NO_PUBLIC_IP;
                termLog("switch", `give-up baseline from probe: ip=${this._giveUpIp}`);
              }
            }).catch(() => {});
          }
          termLog("switch", `RTC give-up: hard NAT → WS-only (ip=${this._giveUpIp || "pending"})`);
          return;
        }
        this._probeAttempts = 0; // soft/unknown → let the cadence climb again from 30s
      }
    } else {
      delay = RTC_RESTART.backoffMs[attempt] ?? RTC_RESTART.backoffMs.at(-1);
    }
    this._rtcRestartAttempts++;
    // TEMP DIAGNOSTIC
    termLog("switch", `scheduleRtcRestart by=${callerTrace()} attempt=${this._rtcRestartAttempts} delay=${delay}ms probe=${isProbe}`);
    debugLog("transport", `[pm] schedule rtc ${isProbe ? "probe" : "restart"} #${this._rtcRestartAttempts} in ${delay}ms`);
    clearTimeout(this._rtcRestartTimer);
    this._rtcRestartTimer = setTimeout(() => {
      this._rtcRestartTimer = null;
      if (this._awaitingApproval) return;
      if (!this._sig?.ready) return; // DO down — _onSignalingReady will restart
      // Only tear down a peer past its natural connect timeout. A younger peer
      // is still doing ICE — killing it on the first 500ms tick restarted the
      // loop forever. Let the adapter's own _connectTimer close it (→ the closed
      // branch restarts) and just reschedule.
      const rtc = this._adapters.get("rtc");
      if (rtc && rtc.state === ADAPTER_STATE.connecting) {
        const age = Date.now() - (rtc.connectingSince ?? 0);
        if (age < RTC_CONNECT_TIMEOUT_MS) {
          this._scheduleRtcRestart(); // peer still young → try again later
          return;
        }
        try { rtc.disconnect(); } catch {}
        this._adapters.delete("rtc");
        this._rtcSignalingHandler = null;
      }
      this._restartRtc();
    }, delay);
  }

  // ─── Signaling routing (cross-adapter for RTC) ────────────────────────────

  _sendSignaling(msg) {
    // DO is the sole signaling carrier — the tunnel carries data only.
    if (this._sig?.ready && this._sig.send(msg)) return;
    this._sigBuffer.push(msg);
    if (this._sigBuffer.length > 32) this._sigBuffer.shift();
  }

  _flushSigBuffer() {
    if (!this._sigBuffer.length) return;
    const queued = this._sigBuffer;
    this._sigBuffer = [];
    for (const msg of queued) this._sendSignaling(msg);
  }
}

// Short per-tab tag appended to deviceId so concurrent tabs don't collide.
function _randomTag() {
  return Math.random().toString(36).slice(2, 10);
}

// Approximate serialized size of control args — cheap upper bound for SCTP limit check.
function _controlBytes(args) {
  let bytes = 0;
  for (const a of args) {
    if (a == null) bytes += 4;
    else if (typeof a === "string") bytes += a.length;
    else bytes += JSON.stringify(a).length;
  }
  return bytes;
}
