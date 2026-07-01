import { BaseProtocol } from "./BaseProtocol";
import { TunnelAdapter } from "./adapters/TunnelAdapter";
import { LocalFirstAdapter } from "./adapters/LocalFirstAdapter";
import { API_ENDPOINTS } from "@/shared/constants/API";
import { FEATURES, BEHAVIOR } from "@/shared/constants/features";
import { ADAPTER_STATE, CHANNELS } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";

const RETRY = BEHAVIOR.retry;

/**
 * WsProtocol — Socket.IO transport adapter.
 * Owns: connection strategy (tunnel/local-first), retry, visibility reconnect.
 * Channels: control (Socket.IO emit). Binary supported via "tiles-bin-v2".
 */
export class WsProtocol extends BaseProtocol {
  static id = "ws";
  static capabilities = { control: true, binary: true, signaling: "ws" };
  static priority = { control: 100, binary: 10 };

  constructor() {
    super();
    this._socket = null;
    this._connectionMode = "local";
    this._retryTimer = null;
    this._retryAttempt = 0;
    this._retryScheduled = false;
    this._destroyed = false;
    this._blocked = false;
    this._connecting = false;
    this._visibilityHandler = null;
  }

  get socket() { return this._socket; }
  get connectionMode() { return this._connectionMode; }
  get blocked() { return this._blocked; }

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
    return false;
  }

  /** Subscribe directly to raw socket event (used internally by RTC for signaling).
   *  Caller responsible for re-attaching after stateChange=open (PM does this). */
  onRaw(event, handler) {
    this._socket?.on(event, handler);
  }

  offRaw(event, handler) {
    this._socket?.off(event, handler);
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
        this._maxAttempts = this._reconnectMaxAttempts;
        this._cancelRetry();
        this._attachSocketEvents(socket);
        debugLog("transport", `[ws] connect mode=${mode}`);
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
      this._setState(ADAPTER_STATE.degraded);
      // Reconnect unless adapter was intentionally destroyed (PM.disconnect / unmount)
      if (!this._destroyed) this._forceReconnect();
    });
    socket.on("connect_error", (err) => {
      debugLog("transport", `[ws] connect_error ${err?.message || err}`);
      this._setState(ADAPTER_STATE.degraded);
      this._forceReconnect();
    });

    // Forward all incoming events into unified bus as "message" (tagged source so PM
    // doesn't double-fire raw socket listeners — socket.io already invoked them natively)
    socket.onAny((event, data) => {
      this._emit("message", { event, data, source: "ws" });
    });

    this._removeNetworkListeners();

    this._visibilityHandler = () => {
      if (document.visibilityState === "visible" && !this._socket?.connected) this._forceReconnect();
    };
    this._offlineHandler = () => {
      this._socket?.disconnect();
      this._socket = null;
      this._setState(ADAPTER_STATE.degraded);
    };
    this._onlineHandler = () => this._forceReconnect();

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
    if (this._destroyed || this._blocked || this._retryScheduled) return;
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
    this._retryAttempt++;
    const attempt = this._retryAttempt;

    if (attempt > this._maxAttempts) {
      this._retryScheduled = false;
      this._ctx?.onRetryStatus?.({ isRetrying: false, attempt, maxAttempts: this._maxAttempts, failed: true });
      this._setState(ADAPTER_STATE.closed);
      return;
    }

    debugLog("transport", `[ws] retry attempt=${attempt}/${this._maxAttempts}`);
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
    this._retryAttempt = 0;
    this._retryScheduled = false;
    this._ctx?.onRetryStatus?.({ isRetrying: false, attempt: 0, maxAttempts: this._maxAttempts, failed: false });
  }
}
