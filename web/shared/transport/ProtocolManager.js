import { WsProtocol } from "./WsProtocol";
import { WebRtcProtocol } from "./WebRtcProtocol";
import { registerProtocol, getProtocol } from "./registry";
import { TRANSPORT_PROFILES, CHANNELS, ADAPTER_STATE, CONTROL_RTC_MAX_BYTES, RTC_RESTART, SIGNALING_CONFIG, NET_RECOVERY, SIGNALING_ERRORS } from "@/shared/constants/transport";
import { WORKER_API } from "@/shared/constants/API";
import { isWsZombie } from "./wsZombie";
import { debugLog } from "@/shared/utils/debugLog";

// Auto-register built-in adapters
registerProtocol(WsProtocol);
registerProtocol(WebRtcProtocol);

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
    // Public IP last seen via STUN — identity of the network we negotiated on.
    this._netFingerprint = null;
    // Set when the agent answers "not approved" — pauses RTC recovery until the
    // host acts, so we don't spin offers the agent will only refuse again.
    this._awaitingApproval = false;
    this._ackTimeoutMs = RTC_RESTART.ackTimeoutMs;

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
      if (document.visibilityState !== "visible") return;
      const ws = this._adapters.get("ws");
      // WS zombie: socket.io still reports connected after background suspension
      // froze its pings, so it looks ready but no bytes flow (terminal/remote go
      // dead with NO disconnect modal, and only an app reload recovers). Break the
      // zombie socket so the normal reconnect path replaces it.
      // lastInboundAt comes from Engine.IO "pong" (true liveness, independent of
      // app traffic or RTC) so an idle-but-alive WS is never mistaken for a zombie.
      const wsZombie = ws?.ready && isWsZombie({
        ready: true,
        lastInboundAt: ws.lastInboundAt ?? 0,
        now: Date.now()
      });
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
      if (!this._canSignal()) {
        // Both carriers down (background froze them too) — kick the relay and
        // let its onReady restart RTC once a path exists again.
        this._sig?.retryNow();
        return;
      }
      const rtc = this._adapters.get("rtc");
      if (!rtc || rtc.state === ADAPTER_STATE.closed || rtc.state === ADAPTER_STATE.degraded) {
        this._restartRtc();
      }
    };
    document.addEventListener("visibilitychange", this._visibilityHandler);

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
        // 3 restarts on a bad network is locked to the tunnel forever.
        this._rtcRestartAttempts = 0;
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
    // RTC-first: bring up RTC (via DO signaling) immediately. The tunnel WS is
    // lazy — only spawned when RTC fails or never opens, so a working P2P path
    // isn't shadowed by tunnel-connect noise/errors.
    this._sigDestroyed = false;
    this._initSignalingClient();
    this._startSecondaryAdapters();
    debugLog("transport", "[pm] connect: RTC-first (DO signaling). WS tunnel deferred until RTC fails.");
    // Safety: if RTC hasn't opened within the grace window, fall back to WS so
    // the app is never stuck with no transport at all.
    this._wsFallbackTimer = setTimeout(() => {
      if (this._onConnectFired) return; // RTC (or WS) already up
      debugLog("transport", "[pm] RTC grace expired without open → starting WS tunnel fallback");
      this._startWsFallback();
    }, RTC_RESTART.ackTimeoutMs * 2);
  }

  // Spawn the WS tunnel adapter on demand (RTC failed or grace expired).
  async _startWsFallback() {
    if (this._adapters.has("ws")) return;
    // RTC-only sessions have no WS connection to push URL updates through, so the
    // cached tunnelUrl may be stale (cloudflared restarted → new trycloudflare URL).
    // Re-fetch the latest URL from the Worker before connecting.
    await this._refreshTunnelUrl();
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

  /** STUN reported a different public IP → we are on another network. Restores
   * the restart budget so a session that exhausted it elsewhere can retry here. */
  _onNetFingerprint(ip) {
    if (!ip || ip === this._netFingerprint) return;
    const prev = this._netFingerprint;
    this._netFingerprint = ip;
    if (!prev) return; // first gather of the session — nothing changed yet
    debugLog("transport", "[pm] network identity changed → reset rtc restart budget");
    this._rtcRestartAttempts = 0;
  }

  _startSecondaryAdapters() {
    debugLog("transport", `[pm] startSecondary enabled=${this._profile.enabled}`);
    for (const id of this._profile.enabled) {
      if (id === "ws") continue;
      if (this._adapters.has(id)) continue;
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
    this._flushSigBuffer();
    if (this._awaitingApproval) return; // policy answer pending — a re-offer changes nothing
    // First connect already has RTC negotiating — only step in once it's dead.
    const rtc = this._adapters.get("rtc");
    if (rtc && rtc.state === ADAPTER_STATE.closed) this._restartRtc();
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
    const rtc = this._adapters.get("rtc");
    // Another recovery path (visibility, signaling-ready, net handler) already
    // spun up a new peer — don't kill it mid-handshake. Only restart dead/idle.
    if (rtc && (rtc.state === ADAPTER_STATE.connecting || rtc.state === ADAPTER_STATE.open)) return;
    if (!rtc) { this._startSecondaryAdapters(); return; }
    debugLog("transport", "[pm] ws reconnected → restart rtc");
    try { rtc.disconnect(); } catch {}
    this._adapters.delete("rtc");
    this._rtcSignalingHandler = null;
    this._startSecondaryAdapters();
  }

  disconnect() {
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
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
    this._rtcRestartAttempts = 0;
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

    if (adapterId === "ws") {
      const ws = this._adapters.get("ws");
      if (state === ADAPTER_STATE.open) {
        const isReconnect = this._lastWsState === ADAPTER_STATE.degraded;
        this._connected = true;
        this._connectionMode = ws?.connectionMode || "tunnel";
        this._rawSocket = ws?.socket || null;
        // Re-attach proxy listeners to new raw socket
        this._rebindProxyListeners();
        if (this._lastWsState !== ADAPTER_STATE.open) {
          // First WS open after RTC already fired onConnect → just note the tunnel
          // is up (mode/transport update); don't re-fire onConnect (handlers would
          // double-register listeners on the proxy).
          if (this._onConnectFired) {
            this._wsCallbacks.onUrlUpdate?.({});
          } else {
            this._onConnectFired = true;
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
        // Only signal disconnect if NO other adapter is keeping connection alive
        if (!this._anyAdapterReady()) {
          this._onConnectFired = false;
          this._wsCallbacks.onDisconnect?.(state);
        } else {
          debugLog("transport", "[pm] ws down but rtc alive → skip onDisconnect");
        }
      }
      this._lastWsState = state;
    }

    if (adapterId === "rtc" && state === ADAPTER_STATE.open) {
      clearTimeout(this._wsFallbackTimer);
      this._rtcCallbacks.onUpgrade?.(this._adapters.get("rtc")?.typeDetail || "dc-stun");
      // RTC opened first (tunnel not up yet) — fire onConnect so workspace hooks
      // get the proxy socket and stop waiting for the tunnel. Data rides RTC.
      if (!this._onConnectFired) {
        this._onConnectFired = true;
        this._connected = true;
        this._connectionMode = "webrtc";
        this._wsCallbacks.onConnect?.(this._proxySocket, this._connectionMode);
      }
      // Successful RTC open → reset zombie recovery attempts
      this._rtcRestartAttempts = 0;
      clearTimeout(this._rtcRestartTimer);
      this._rtcRestartTimer = null;
    }
    if (adapterId === "rtc" && state === ADAPTER_STATE.closed) {
      this._rtcCallbacks.onFallback?.("ws");
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
    const attempt = this._rtcRestartAttempts;
    const isProbe = attempt >= RTC_RESTART.maxAttempts;
    const delay = isProbe
      ? RTC_RESTART.probeIntervalMs
      : (RTC_RESTART.backoffMs[attempt] ?? RTC_RESTART.backoffMs.at(-1));
    this._rtcRestartAttempts++;
    debugLog("transport", `[pm] schedule rtc ${isProbe ? "probe" : "restart"} #${this._rtcRestartAttempts} in ${delay}ms`);
    clearTimeout(this._rtcRestartTimer);
    this._rtcRestartTimer = setTimeout(() => {
      this._rtcRestartTimer = null;
      if (this._awaitingApproval) return;
      if (!this._sig?.ready) return; // DO down — _onSignalingReady will restart
      // Kill a stale connecting adapter — its offer was already refused or its
      // ICE is stuck. Waiting for ICE timeout wastes a probe cycle; _restartRtc's
      // guard would otherwise block the restart and strand the probe loop.
      const rtc = this._adapters.get("rtc");
      if (rtc && rtc.state === ADAPTER_STATE.connecting) {
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
