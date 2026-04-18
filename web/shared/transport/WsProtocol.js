import { BaseProtocol } from "./BaseProtocol";
import { TunnelAdapter } from "./adapters/TunnelAdapter";
import { LocalFirstAdapter } from "./adapters/LocalFirstAdapter";
import { API_ENDPOINTS } from "@/shared/constants/API";
import { FEATURES, BEHAVIOR } from "@/shared/constants/features";

const RETRY = BEHAVIOR.retry;

/**
 * WsProtocol — Socket.IO transport adapter.
 *
 * Delegates connection strategy to adapters:
 *   - TunnelAdapter    — direct tunnel connect
 *   - LocalFirstAdapter — race local LAN vs tunnel, winner takes all
 *
 * Owns: retry logic, socket lifecycle, visibility reconnect.
 */
export class WsProtocol extends BaseProtocol {
  constructor({ tunnelUrl, localIp, namespace = "", socketOptions = {}, apiKey, tempKey = null, onConnect, onDisconnect, onRetryStatus, onUrlUpdate }) {
    super();
    this._tunnelUrl = tunnelUrl;
    this._localIp = localIp || null;
    this._namespace = namespace;
    this._socketOptions = socketOptions;
    this._apiKey = apiKey;
    // Saved Keys retry fewer times than onetime key (tempKey)
    this._maxAttempts = tempKey ? RETRY.maxAttempts : RETRY.savedKeyMaxAttempts;
    this._onConnect = onConnect;
    this._onDisconnect = onDisconnect;
    this._onRetryStatus = onRetryStatus;
    this._onUrlUpdate = onUrlUpdate;

    this._socket = null;
    this._connected = false;
    this._connectionMode = "local";
    this._retryTimer = null;
    this._retryAttempt = 0;
    this._retryScheduled = false;
    this._destroyed = false;
    this._visibilityHandler = null;
  }

  get type() { return "ws"; }
  get connected() { return this._connected; }
  get socket() { return this._socket; }
  get connectionMode() { return this._connectionMode; }

  on(event, handler) { this._socket?.on(event, handler); }
  off(event, handler) { this._socket?.off(event, handler); }
  emit(event, data) { this._socket?.emit(event, data); }

  connect() {
    const adapterConfig = {
      tunnelUrl: this._tunnelUrl,
      namespace: this._namespace,
      socketOptions: this._socketOptions
    };

    // Skip local probe if last connection was tunnel (different network)
    // Reset to LocalFirst when _scheduleRetry fetches fresh URLs
    const adapter = (FEATURES.localFirstConnection && this._localIp && this._connectionMode !== "tunnel")
      ? new LocalFirstAdapter({ ...adapterConfig, localIp: this._localIp })
      : new TunnelAdapter(adapterConfig);

    adapter.connect({
      onSocket: (socket, mode) => {
        this._connectionMode = mode;
        this._socket = socket;
        this._connected = true;
        this._retryAttempt = 0; // Reset on successful connect
        this._cancelRetry();
        this._onConnect?.(socket, mode);
        this._attachSocketEvents(socket);
      },
      onFail: () => this._scheduleRetry()
    });
  }

  _attachSocketEvents(socket) {
    socket.on("disconnect", (reason) => {
      this._connected = false;
      this._onDisconnect?.(reason);
      if (reason !== "io client disconnect") this._forceReconnect();
    });

    socket.on("connect_error", () => {
      this._connected = false;
      this._forceReconnect();
    });

    // Remove old listeners before re-attaching to avoid duplicates on reconnect
    this._removeNetworkListeners();

    this._visibilityHandler = () => {
      if (document.visibilityState === "visible" && !this._socket?.connected) {
        this._forceReconnect();
      }
    };
    this._offlineHandler = () => {
      this._socket?.disconnect();
      this._socket = null;
      this._connected = false;
    };
    this._onlineHandler = () => this._forceReconnect();

    document.addEventListener("visibilitychange", this._visibilityHandler);
    window.addEventListener("offline", this._offlineHandler);
    window.addEventListener("online", this._onlineHandler);
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

  // Reconnect immediately. After 3 fast failures, fetch fresh URLs via retry.
  _forceReconnect() {
    if (this._destroyed || this._retryScheduled) return;
    this._retryAttempt++;

    if (this._retryAttempt > BEHAVIOR.reconnect.fastFailThreshold) {
      this._retryAttempt = 0;
      this._scheduleRetry();
      return;
    }

    this._socket?.disconnect();
    this._socket = null;
    this._connected = false;
    this.connect();
  }

  disconnect() {
    this._destroyed = true;
    this._cancelRetry();
    this._removeNetworkListeners();
    this._socket?.disconnect();
    this._socket = null;
    this._connected = false;
  }

  // ─── Retry logic ──────────────────────────────────────────────────────────

  _scheduleRetry() {
    if (this._retryScheduled || this._destroyed) return;
    this._retryScheduled = true;
    this._retryTimer = setTimeout(() => this._doRetry(), RETRY.interval);
  }

  async _doRetry() {
    if (this._destroyed) return;
    this._retryAttempt++;
    const attempt = this._retryAttempt;

    if (attempt > this._maxAttempts) {
      this._retryScheduled = false;
      this._onRetryStatus?.({ isRetrying: false, attempt, maxAttempts: this._maxAttempts, failed: true });
      return;
    }

    this._onRetryStatus?.({ isRetrying: true, attempt, maxAttempts: this._maxAttempts, failed: false });

    try {
      const resp = await fetch(API_ENDPOINTS.connect, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: this._apiKey })
      });
      if (!resp.ok) throw new Error("Failed");
      const { tunnelUrl, localIp } = await resp.json();
      this._tunnelUrl = tunnelUrl;
      this._localIp = localIp || null;
      this._connectionMode = "local"; // Reset so next connect probes local again
      this._onUrlUpdate?.({ tunnelUrl, localIp });
      this._socket?.disconnect();
      this._retryScheduled = false;
      this.connect();
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
    this._onRetryStatus?.({ isRetrying: false, attempt: 0, maxAttempts: this._maxAttempts, failed: false });
  }
}
