import { WsProtocol } from "./WsProtocol";
import { WebRtcProtocol } from "./WebRtcProtocol";
import { registerProtocol, getProtocol } from "./registry";
import { TRANSPORT_PROFILES, CHANNELS, ADAPTER_STATE, CONTROL_RTC_MAX_BYTES, RTC_RESTART } from "@/shared/constants/transport";
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
      namespace: wsConfig.namespace,
      socketOptions: wsConfig.socketOptions
    };
    this._wsCallbacks = {
      onConnect: wsConfig.onConnect,
      onDisconnect: wsConfig.onDisconnect,
      onRetryStatus: wsConfig.onRetryStatus,
      onUrlUpdate: wsConfig.onUrlUpdate
    };
    this._rtcCallbacks = rtcConfig ? {
      onUpgrade: rtcConfig.onUpgrade,
      onFallback: rtcConfig.onFallback,
      onTransportChange: rtcConfig.onTransportChange
    } : {};

    this._adapters = new Map();   // id → adapter instance
    this._listeners = new Map();  // event → Set<handler>
    this._buffer = [];            // pending control sends when no adapter ready
    this._pendingAcks = new Map(); // ackId → callback (RTC ack)
    this._ackTimers = new Map();  // ackId → timeout (zombie detection)
    this._ackSeq = 0;

    // RTC zombie recovery — restart with backoff when acks time out (dead-but-open DC)
    this._rtcRestartAttempts = 0;
    this._rtcRestartTimer = null;
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
        // Fall through: WS may take time to reconnect; also restart RTC now so the
        // binary channel recovers in parallel (RTC dies on background too, and the
        // user's symptom is BOTH dead — fix them together, don't wait for WS open).
      }
      if (!ws?.ready) {
        // WS not alive — can't carry signaling for a fresh RTC negotiation here;
        // it will restart on WS open (isReconnect path). Nothing more to do now.
        return;
      }
      const rtc = this._adapters.get("rtc");
      if (!rtc || rtc.state === ADAPTER_STATE.closed || rtc.state === ADAPTER_STATE.degraded) {
        this._restartRtc();
      }
    };
    document.addEventListener("visibilitychange", this._visibilityHandler);

    // Cross-adapter signaling — RTC pulls this from connect ctx
    this._rtcSignalingHandler = null;
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
        pm._rawSocket?.once(event, handler);
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

  connect() {
    // Phase 1: connect primary (WS). Other adapters wait for WS open.
    this._instantiate("ws");
    this._adapters.get("ws")?.connect(this._buildCtx("ws"));
  }

  _instantiate(id) {
    if (this._adapters.has(id)) return;
    const Adapter = getProtocol(id);
    if (!Adapter) return;
    const inst = new Adapter();
    inst.on("stateChange", (state) => this._onAdapterStateChange(id, state));
    inst.on("message", ({ event, data, source }) => this._dispatch(event, data, source));
    this._adapters.set(id, inst);
  }

  _startSecondaryAdapters() {
    for (const id of this._profile.enabled) {
      if (id === "ws") continue;
      if (this._adapters.has(id)) continue;
      this._instantiate(id);
      this._adapters.get(id)?.connect(this._buildCtx(id));
    }
  }

  /** Tear down RTC + renegotiate via new WS socket (called on WS reconnect). */
  _restartRtc() {
    const rtc = this._adapters.get("rtc");
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
        on: (handler) => { this._rtcSignalingHandler = handler; this._installSignalingListeners(); },
        off: () => { this._rtcSignalingHandler = null; this._removeSignalingListeners(); }
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
        // Stale listeners on dead socket — recreate on new socket
        this._sigListeners = null;
        this._installSignalingListeners();
        if (this._lastWsState !== ADAPTER_STATE.open) {
          // Pass proxy socket so consumer's onConnect handlers register listeners on PROXY
          // (which auto re-binds to new raw socket after reconnect)
          this._wsCallbacks.onConnect?.(this._proxySocket, this._connectionMode);
        }
        // On WS reconnect, server creates new PM → must renegotiate RTC via new socket
        if (isReconnect) this._restartRtc();
        else this._startSecondaryAdapters();
      } else if (this._lastWsState === ADAPTER_STATE.open) {
        this._rawSocket = null;
        // Only signal disconnect if NO other adapter is keeping connection alive
        if (!this._anyAdapterReady()) {
          this._wsCallbacks.onDisconnect?.(state);
        } else {
          debugLog("transport", "[pm] ws down but rtc alive → skip onDisconnect");
        }
      }
      this._lastWsState = state;
    }

    if (adapterId === "rtc" && state === ADAPTER_STATE.open) {
      this._rtcCallbacks.onUpgrade?.(this._adapters.get("rtc")?.typeDetail || "dc-stun");
      // Successful RTC open → reset zombie recovery attempts
      this._rtcRestartAttempts = 0;
      clearTimeout(this._rtcRestartTimer);
      this._rtcRestartTimer = null;
    }
    if (adapterId === "rtc" && state === ADAPTER_STATE.closed) {
      this._rtcCallbacks.onFallback?.("ws");
      // Reject acks of requests sent over the now-dead RTC DC so callers fail
      // fast instead of hanging until the 30s cleanup silently drops them.
      for (const cb of this._pendingAcks.values()) {
        try { cb({ error: "rtc-closed" }); } catch {}
      }
      this._pendingAcks.clear();
      for (const t of this._ackTimers.values()) clearTimeout(t);
      this._ackTimers.clear();
      // RTC died — if WS also down, emit disconnect now (was suppressed earlier)
      if (!this._anyAdapterReady()) {
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

  // Schedule a restart attempt with backoff. Caps at maxAttempts → gives up (WS owns).
  _scheduleRtcRestart() {
    if (this._rtcRestartAttempts >= RTC_RESTART.maxAttempts) {
      debugLog("transport", `[pm] rtc restart cap reached (${RTC_RESTART.maxAttempts}) → ws owns`);
      return;
    }
    const attempt = this._rtcRestartAttempts;
    const delay = RTC_RESTART.backoffMs[attempt] ?? RTC_RESTART.backoffMs[RTC_RESTART.backoffMs.length - 1];
    this._rtcRestartAttempts++;
    debugLog("transport", `[pm] schedule rtc restart #${this._rtcRestartAttempts} in ${delay}ms`);
    clearTimeout(this._rtcRestartTimer);
    this._rtcRestartTimer = setTimeout(() => {
      this._rtcRestartTimer = null;
      // Only restart if WS is alive (signaling needs WS to renegotiate)
      const ws = this._adapters.get("ws");
      if (!ws?.ready) {
        debugLog("transport", "[pm] skip rtc restart — ws down (no signaling)");
        return;
      }
      this._restartRtc();
    }, delay);
  }

  // ─── Signaling routing (cross-adapter for RTC) ────────────────────────────

  _sendSignaling(msg) {
    const ws = this._adapters.get("ws");
    if (ws?.ready) {
      ws.send(CHANNELS.control, { event: this._sigEvent(msg.type), args: [this._sigData(msg)] });
      return;
    }
    // No fallback signaling — RTC stays alive on its own DC after established
    debugLog("transport", "[pm] signal dropped: ws down");
  }

  _sigEvent(type) {
    return type === "offer" ? "webrtc:offer"
      : type === "answer" ? "webrtc:answer"
      : type === "ice" ? "webrtc:ice-candidate"
      : "webrtc:error";
  }

  _sigData(msg) {
    if (msg.type === "offer" || msg.type === "answer") return { sdp: msg.sdp };
    if (msg.type === "ice") return { candidate: msg.candidate, mid: msg.mid };
    return msg;
  }

  _installSignalingListeners() {
    if (!this._rtcSignalingHandler || this._sigListeners) return;
    const ws = this._adapters.get("ws");
    if (!ws?.socket) return;

    const onOffer = ({ sdp }) => this._rtcSignalingHandler?.({ type: "offer", sdp });
    const onAnswer = ({ sdp }) => this._rtcSignalingHandler?.({ type: "answer", sdp });
    const onIce = ({ candidate, mid }) => this._rtcSignalingHandler?.({ type: "ice", candidate, mid });
    const onErr = ({ message }) => this._rtcSignalingHandler?.({ type: "error", message });

    this._sigListeners = { onOffer, onAnswer, onIce, onErr };
    ws.onRaw("webrtc:offer", onOffer);
    ws.onRaw("webrtc:answer", onAnswer);
    ws.onRaw("webrtc:ice-candidate", onIce);
    ws.onRaw("webrtc:error", onErr);
  }

  _removeSignalingListeners() {
    const ws = this._adapters.get("ws");
    if (!ws?.socket || !this._sigListeners) return;
    const { onOffer, onAnswer, onIce, onErr } = this._sigListeners;
    ws.offRaw("webrtc:offer", onOffer);
    ws.offRaw("webrtc:answer", onAnswer);
    ws.offRaw("webrtc:ice-candidate", onIce);
    ws.offRaw("webrtc:error", onErr);
    this._sigListeners = null;
  }
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
