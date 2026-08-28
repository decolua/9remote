import { BaseProtocol } from "./BaseProtocol";
import { TunnelAdapter } from "./adapters/TunnelAdapter";
import { LocalFirstAdapter } from "./adapters/LocalFirstAdapter";
import { API_ENDPOINTS } from "@/shared/constants/API";
import { FEATURES, BEHAVIOR } from "@/shared/constants/features";
import { ADAPTER_STATE, CHANNELS } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";

const RETRY = BEHAVIOR.retry;

/**
 * WsProtocol — Socket.IO transport adapter.
 * Owns: connection strategy (tunnel/local-first), retry, visibility reconnect.
 * Channels: control (Socket.IO emit). Binary supported via "tiles-bin-v2".
 */
// A single app switch can fire visibilitychange + online back to back; both
// drive retryNow. Collapse that burst (same value SignalingClient uses).
const RETRY_NOW_THROTTLE_MS = 3000;

export class WsProtocol extends BaseProtocol {
  static id = "ws";
  static capabilities = { control: true, binary: true, file: true, signaling: "ws" };
  static priority = { control: 100, binary: 10, file: 10 };

  constructor() {
    super();
    this._socket = null;
    this._connectionMode = "local";
    this._retryTimer = null;
    this._retryAttempt = 0;
    this._retryScheduled = false;
    this._retryNowTimer = null;
    this._destroyed = false;
    this._blocked = false;
    this._updating = false;
    this._connecting = false;
    this._visibilityHandler = null;
    // Engine.IO liveness — updated by the built-in "pong" event (every pingInterval
    // even when no app bytes flow), so an idle-but-alive socket is never mistaken
    // for a zombie. PM reads this on resume to decide whether to force a reconnect.
    this._lastInboundAt = Date.now();
    // TEMP DIAGNOSTIC — last app-level event received (vs pong heartbeat).
    // If this stays fresh while lastInboundAt goes stale, pong stamping is broken.
    this._lastMsgAt = 0;
  }

  /** Last Engine.IO pong timestamp — real transport liveness (independent of RTC). */
  get lastInboundAt() { return this._lastInboundAt; }
  /** TEMP DIAGNOSTIC — last app event received. */
  get lastMsgAt() { return this._lastMsgAt; }

  get socket() { return this._socket; }
  get connectionMode() { return this._connectionMode; }
  get blocked() { return this._blocked; }

  /** Widen retry window during agent self-update; auto-clears on next successful connect. */
  setUpdating(updating) {
    this._updating = updating;
    if (updating) {
      this._maxAttempts = RETRY.updateReconnectMaxAttempts;
      this._retryAttempt = 0;
      debugLog("transport", `[ws] updating=true maxAttempts=${this._maxAttempts}`);
    }
  }

  /**
   * Force a reconnect from outside (e.g. ProtocolManager detected a zombie socket
   * that still reports connected after background suspension). Public wrapper for
   * the internal reconnect path so PM doesn't reach into private state.
   */
  forceReconnect() {
    if (this._destroyed) return;
    this._forceReconnect();
  }

  /**
   * User-triggered retry — skips the pending backoff timer and starts a fresh
   * attempt window. Unlike forceReconnect() this also revives the "failed"
   * terminal state (attempt counter exhausted, adapter closed).
   */
  retryNow(reason = "?") {
    if (this._blocked) { termLog("switch", `ws retryNow SKIP by=${reason} (blocked)`); return; }
    // Mobile fires visibilitychange and online within milliseconds of one
    // another, and both handlers land here. Since retryNow clears _connecting
    // itself, the second call would tear down the socket the first one had just
    // started handshaking — so collapse a burst into one attempt. Mirrors the
    // throttle SignalingClient already applies to its own retryNow.
    const now = Date.now();
    const sinceLast = now - (this._lastRetryNowAt || 0);
    if (sinceLast < RETRY_NOW_THROTTLE_MS) {
      // Deferred, never dropped: the throttled call may be the only one that
      // knows the network is back, so re-run it at the end of the window
      // instead of discarding it (one pending re-check, not a queue).
      if (!this._retryNowTimer) {
        this._retryNowTimer = setTimeout(() => {
          this._retryNowTimer = null;
          this.retryNow(`${reason}-deferred`);
        }, RETRY_NOW_THROTTLE_MS - sinceLast);
      }
      debugLog("transport", "[ws] retryNow throttled → deferred");
      termLog("switch", `ws retryNow DEFER by=${reason} (${RETRY_NOW_THROTTLE_MS - sinceLast}ms left)`);
      return;
    }
    termLog("switch", `ws retryNow GO by=${reason} (drops attempt ${this._retryAttempt})`);
    this._lastRetryNowAt = now;
    clearTimeout(this._retryNowTimer);
    this._retryNowTimer = null;
    clearTimeout(this._retryTimer);
    clearTimeout(this._connectingTimer);
    this._retryTimer = null;
    this._retryScheduled = false;
    this._retryAttempt = 0;
    this._connecting = false;
    // Drop the old socket under the destroyed flag — its "disconnect" handler fires
    // synchronously and would otherwise race the _connectInternal below.
    this._destroyed = true;
    this._detachSocketEvents();
    this._socket?.disconnect();
    this._socket = null;
    this._destroyed = false;
    this._ctx?.onRetryStatus?.({ isRetrying: true, attempt: 1, maxAttempts: this._maxAttempts, failed: false });
    this._setState(ADAPTER_STATE.connecting);
    this._connectInternal();
  }

  /** Dev/test: prevent reconnect attempts. When unblocked, schedule retry immediately. */
  setBlocked(blocked) {
    this._blocked = blocked;
    debugLog("transport", `[ws] blocked=${blocked}`);
    if (blocked) {
      this._cancelRetry();
      this._socket?.disconnect();
    } else if (!this._socket?.connected && !this._destroyed) {
      this._connectInternal();
    }
  }

  /**
   * @param {object} ctx
   * @param {object} ctx.auth         — { tunnelUrl, localIp, apiKey, tempKey, deviceId, namespace, socketOptions }
   * @param {Function} ctx.onRetryStatus
   * @param {Function} ctx.onUrlUpdate
   */
  connect(ctx) {
    this._ctx = ctx;
    this._auth = ctx.auth;
    this._maxAttempts = this._auth.tempKey ? RETRY.maxAttempts : RETRY.savedKeyMaxAttempts;
    this._reconnectMaxAttempts = RETRY.reconnectMaxAttempts;
    this._destroyed = false;
    this._attachNetworkListeners();
    this._setState(ADAPTER_STATE.connecting);
    this._connectInternal();
  }

  disconnect() {
    this._destroyed = true;
    this._cancelRetry();
    this._removeNetworkListeners();
    this._detachSocketEvents();
    this._socket?.disconnect();
    this._socket = null;
    this._setState(ADAPTER_STATE.closed);
  }

  send(channel, payload) {
    if (!this._socket?.connected) return false;
    if (channel === CHANNELS.control) {
      const { event, args = [], cb } = payload;
      if (cb) this._socket.emit(event, ...args, cb);
      else this._socket.emit(event, ...args);
      return true;
    }
    if (channel === CHANNELS.binary) {
      this._socket.emit("tiles-bin-v2", payload);
      return true;
    }
    if (channel === CHANNELS.file) {
      this._socket.emit("file-bin", payload);
      return true;
    }
    return false;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _connectInternal() {
    // Guard concurrent connects — iOS wake fires online/visibility/disconnect together,
    // each calling _forceReconnect → duplicate sockets → tiles stream to wrong socket (black canvas).
    if (this._connecting || this._socket?.connected || this._destroyed) return;
    this._connecting = true;
    // Safety: iOS may suspend mid-connect so onSocket/onFail never fire → clear the flag
    // after a grace window so future reconnects aren't permanently blocked.
    clearTimeout(this._connectingTimer);
    this._connectingTimer = setTimeout(() => { this._connecting = false; }, RETRY.interval);

    const adapterConfig = {
      tunnelUrl: this._auth.tunnelUrl,
      namespace: this._auth.namespace || "",
      socketOptions: this._auth.socketOptions || {}
    };

    debugLog("transport", `[ws] connect: tunnelUrl=${this._auth.tunnelUrl} localIp=${this._auth.localIp || "none"}`);

    const adapter = (FEATURES.localFirstConnection && this._auth.localIp && this._connectionMode !== "tunnel")
      ? new LocalFirstAdapter({ ...adapterConfig, localIp: this._auth.localIp })
      : new TunnelAdapter(adapterConfig);

    adapter.connect({
      onSocket: (socket, mode) => {
        this._connecting = false;
        clearTimeout(this._connectingTimer);
        // Late-arriving duplicate — a socket already won the race; drop this one.
        if (this._socket?.connected && this._socket !== socket) { try { socket.disconnect(); } catch {} return; }
        this._connectionMode = mode;
        this._socket = socket;
        this._retryAttempt = 0;
        this._updating = false;
        this._maxAttempts = this._reconnectMaxAttempts;
        this._cancelRetry();
        this._attachSocketEvents(socket);
        debugLog("transport", `[ws] connect mode=${mode}`);
        termLog("switch", `ws open mode=${mode}`);
        this._setState(ADAPTER_STATE.open);
      },
      onFail: () => {
        this._connecting = false;
        clearTimeout(this._connectingTimer);
        debugLog("transport", "[ws] connect FAIL → schedule retry");
        this._scheduleRetry();
      }
    });
  }

  _attachSocketEvents(socket) {
    socket.on("disconnect", (reason) => {
      debugLog("transport", `[ws] disconnect reason=${reason}`);
      termLog("switch", `ws disconnect reason=${reason}`);
      this._setState(ADAPTER_STATE.degraded);
      // Reconnect unless adapter was intentionally destroyed (PM.disconnect / unmount)
      if (!this._destroyed) this._forceReconnect();
    });
    socket.on("connect_error", (err) => {
      debugLog("transport", `[ws] connect_error ${err?.message || err}`);
      this._setState(ADAPTER_STATE.degraded);
      this._forceReconnect();
    });

    // Engine.IO heartbeat — the "pong" reply arrives every pingInterval (~25s)
    // regardless of app traffic, so it's a true liveness signal. Stamp it so the
    // zombie probe (PM visibility handler) can distinguish an idle-but-alive
    // socket from one frozen by OS background suspension.
    socket.io?.on?.("pong", () => {
      this._lastInboundAt = Date.now();
    });
    // Also stamp on connect — a freshly opened socket is by definition alive.
    socket.on("connect", () => { this._lastInboundAt = Date.now(); });

    // Forward all incoming events into unified bus as "message" (tagged source so PM
    // doesn't double-fire raw socket listeners — socket.io already invoked them natively)
    socket.onAny((event, data) => {
      this._lastMsgAt = Date.now(); // TEMP DIAGNOSTIC — app event over WS
      this._emit("message", { event, data, source: "ws" });
    });
  }

  /**
   * Environment listeners, bound for the adapter's whole lifetime — NOT per socket.
   * A session that never opened one (agent offline at page load) still needs the
   * resume path, or it burns its attempts and stays stuck on the failed screen.
   */
  _attachNetworkListeners() {
    if (this._visibilityHandler) return;

    // Resume = the first moment the network is real again, so start a fresh
    // attempt window instead of _forceReconnect (which returns early while a
    // retry timer is pending, leaving the stale counter to run out).
    // Skip while a handshake is in flight — killing it would flash the UI.
    this._visibilityHandler = () => {
      if (document.visibilityState !== "visible") return;
      if (this._socket?.connected || this._connecting) return;
      this.retryNow("visible");
    };
    this._offlineHandler = () => {
      termLog("switch", "ws offline event → drop socket, degraded");
      this._socket?.disconnect();
      this._socket = null;
      this._setState(ADAPTER_STATE.degraded);
    };
    // Same reasoning as the visibility handler: a network handover is a fresh
    // start, and _forceReconnect would be swallowed by a pending retry timer.
    this._onlineHandler = () => {
      if (this._socket?.connected || this._connecting) {
        termLog("switch", `ws online event → skip (${this._connecting ? "handshaking" : "already up"})`);
        return;
      }
      this.retryNow("online");
    };

    // Say goodbye on the way out. Without this the agent only learns the client
    // is gone when socket.io's ping times out — up to 85 seconds of showing a
    // closed browser as online, because a tab closing behind a tunnel produces
    // no clean TCP close the server can see.
    //
    // pagehide, not beforeunload: it fires on mobile too, where a swiped-away
    // app never sees beforeunload at all. Best-effort by nature — a crash or a
    // pulled cable still falls back to the ping timeout, which is why that
    // remains the real safety net.
    this._pagehideHandler = () => {
      try { this._socket?.disconnect(); } catch {}
    };
    window.addEventListener("pagehide", this._pagehideHandler);
    document.addEventListener("visibilitychange", this._visibilityHandler);
    window.addEventListener("offline", this._offlineHandler);
    window.addEventListener("online", this._onlineHandler);
  }

  _detachSocketEvents() {
    if (this._socket) {
      try { this._socket.offAny(); } catch {}
    }
  }

  _removeNetworkListeners() {
    if (this._pagehideHandler) {
      window.removeEventListener("pagehide", this._pagehideHandler);
      this._pagehideHandler = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._offlineHandler) {
      window.removeEventListener("offline", this._offlineHandler);
      this._offlineHandler = null;
    }
    if (this._onlineHandler) {
      window.removeEventListener("online", this._onlineHandler);
      this._onlineHandler = null;
    }
  }

  _forceReconnect() {
    if (this._destroyed || this._blocked || this._retryScheduled || this._connecting) return;
    this._retryAttempt++;
    if (this._retryAttempt > BEHAVIOR.reconnect.fastFailThreshold) {
      this._retryAttempt = 0;
      this._scheduleRetry();
      return;
    }
    this._socket?.disconnect();
    this._socket = null;
    this._connectInternal();
  }

  _scheduleRetry() {
    if (this._retryScheduled || this._destroyed || this._blocked) return;
    this._retryScheduled = true;
    this._retryTimer = setTimeout(() => this._doRetry(), RETRY.interval);
  }

  async _doRetry() {
    if (this._destroyed) return;
    // Backgrounded: the OS cuts networking, so every attempt is a guaranteed
    // failure. Counting them burns the whole budget while hidden — the user
    // returns to "14/15" or a dead "failed" state. Hold the counter instead;
    // the visibility handler starts a real window on resume.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      termLog("switch", `ws retry HOLD (hidden, still at ${this._retryAttempt}/${this._maxAttempts})`);
      this._retryScheduled = false;
      this._scheduleRetry();
      return;
    }
    this._retryAttempt++;
    const attempt = this._retryAttempt;

    if (attempt > this._maxAttempts) {
      this._retryScheduled = false;
      termLog("switch", `ws GAVE UP after ${this._maxAttempts} attempts → closed`);
      this._ctx?.onRetryStatus?.({ isRetrying: false, attempt, maxAttempts: this._maxAttempts, failed: true });
      this._setState(ADAPTER_STATE.closed);
      return;
    }

    debugLog("transport", `[ws] retry attempt=${attempt}/${this._maxAttempts}`);
    termLog("switch", `ws retry ${attempt}/${this._maxAttempts}`);
    this._ctx?.onRetryStatus?.({ isRetrying: true, attempt, maxAttempts: this._maxAttempts, failed: false });

    try {
      const resp = await fetch(API_ENDPOINTS.connect, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: this._auth.apiKey })
      });
      if (!resp.ok) throw new Error("Failed");
      const { tunnelUrl, localIp } = await resp.json();
      this._auth.tunnelUrl = tunnelUrl;
      this._auth.localIp = localIp || null;
      this._connectionMode = "local";
      this._ctx?.onUrlUpdate?.({ tunnelUrl, localIp });
      this._socket?.disconnect();
      this._retryScheduled = false;
      this._connectInternal();
    } catch {
      this._retryScheduled = false;
      this._scheduleRetry();
    }
  }

  _cancelRetry() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    clearTimeout(this._retryNowTimer);
    this._retryNowTimer = null;
    this._retryAttempt = 0;
    this._retryScheduled = false;
    this._ctx?.onRetryStatus?.({ isRetrying: false, attempt: 0, maxAttempts: this._maxAttempts, failed: false });
  }
}
