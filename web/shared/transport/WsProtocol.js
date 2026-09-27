import { BaseProtocol } from "./BaseProtocol";
import { TunnelAdapter } from "./adapters/TunnelAdapter";
import { LocalFirstAdapter } from "./adapters/LocalFirstAdapter";
import { API_ENDPOINTS } from "@/shared/constants/API";
import { FEATURES, BEHAVIOR } from "@/shared/constants/features";
import { ADAPTER_STATE, CHANNELS } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";

const RETRY = BEHAVIOR.retry;

// Collapse visibilitychange + online burst into single retry.
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
    // Engine.IO liveness updated by "pong" heartbeat.
    this._lastInboundAt = Date.now();
    this._lastMsgAt = 0;
    // Generation token to invalidate stale async _doRetry calls.
    this._retrySeq = 0;
  }

  get lastInboundAt() { return this._lastInboundAt; }
  get lastMsgAt() { return this._lastMsgAt; }

  get socket() { return this._socket; }
  get connectionMode() { return this._connectionMode; }
  get blocked() { return this._blocked; }

  /** Widen retry window during host self-update; auto-clears on next successful connect. */
  setUpdating(updating) {
    this._updating = updating;
    if (updating) {
      this._maxAttempts = RETRY.updateReconnectMaxAttempts;
      this._retryAttempt = 0;
      debugLog("transport", `[ws] updating=true maxAttempts=${this._maxAttempts}`);
    }
  }

  // Force reconnect from outside (e.g. zombie socket detection).
  forceReconnect() {
    if (this._destroyed) return;
    this._forceReconnect();
  }

  // User-triggered retry: resets backoff counter and attempts immediate reconnect.
  retryNow(reason = "?") {
    if (this._blocked) { termLog("switch", `ws retryNow SKIP by=${reason} (blocked)`); return; }
    const now = Date.now();
    const sinceLast = now - (this._lastRetryNowAt || 0);
    if (sinceLast < RETRY_NOW_THROTTLE_MS) {
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
    this._retrySeq++;
    this._lastRetryNowAt = now;
    clearTimeout(this._retryNowTimer);
    this._retryNowTimer = null;
    clearTimeout(this._retryTimer);
    clearTimeout(this._connectingTimer);
    this._retryTimer = null;
    this._retryScheduled = false;
    this._retryAttempt = 0;
    this._connecting = false;
    // Set destroyed flag during disconnect to avoid re-triggering reconnect.
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
    this._retrySeq++;
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
    // Guard against concurrent connects (e.g. iOS wake burst).
    if (this._connecting || this._socket?.connected || this._destroyed) return;
    // Hold connect until tunnelUrl or localIp exists.
    if (!this._auth.tunnelUrl && !this._auth.localIp) {
      debugLog("transport", "[ws] connect HOLD (no tunnelUrl/localIp yet) → retry");
      termLog("switch", "ws connect HOLD (no url yet) → fetch on retry");
      this._setState(ADAPTER_STATE.degraded);
      this._scheduleRetry();
      return;
    }
    this._connecting = true;
    // Clear connecting flag after grace window if iOS suspends mid-connect.
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
      if (!this._destroyed) this._forceReconnect();
    });
    socket.on("connect_error", (err) => {
      debugLog("transport", `[ws] connect_error ${err?.message || err}`);
      this._setState(ADAPTER_STATE.degraded);
      this._forceReconnect();
    });

    socket.io?.on?.("pong", () => {
      this._lastInboundAt = Date.now();
    });
    socket.on("connect", () => { this._lastInboundAt = Date.now(); });

    socket.onAny((event, data) => {
      this._lastMsgAt = Date.now();
      this._emit("message", { event, data, source: "ws" });
    });
  }

  _attachNetworkListeners() {
    if (this._visibilityHandler) return;

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
    this._onlineHandler = () => {
      if (this._socket?.connected || this._connecting) {
        termLog("switch", `ws online event → skip (${this._connecting ? "handshaking" : "already up"})`);
        return;
      }
      this.retryNow("online");
    };

    // Disconnect socket on pagehide (works on mobile app switch).
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
    this._retrySeq++;
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
    // Pause retry attempts while document is hidden.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      termLog("switch", `ws retry HOLD (hidden, still at ${this._retryAttempt}/${this._maxAttempts})`);
      this._retryScheduled = false;
      this._scheduleRetry();
      return;
    }
    this._retryAttempt++;
    const attempt = this._retryAttempt;
    const seq = this._retrySeq;

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
      if (seq !== this._retrySeq) {
        termLog("switch", "ws retry ABORT (superseded mid-fetch)");
        return;
      }
      this._auth.tunnelUrl = tunnelUrl;
      this._auth.localIp = localIp || null;
      this._connectionMode = "local";
      this._ctx?.onUrlUpdate?.({ tunnelUrl, localIp });
      this._socket?.disconnect();
      this._retryScheduled = false;
      this._connectInternal();
    } catch {
      if (seq !== this._retrySeq) return;
      this._retryScheduled = false;
      this._scheduleRetry();
    }
  }

  _cancelRetry() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    clearTimeout(this._retryNowTimer);
    this._retryNowTimer = null;
    this._retrySeq++;
    this._retryAttempt = 0;
    this._retryScheduled = false;
    this._ctx?.onRetryStatus?.({ isRetrying: false, attempt: 0, maxAttempts: this._maxAttempts, failed: false });
  }
}
