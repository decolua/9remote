import { WsProtocol } from "./WsProtocol";
import { WebRtcProtocol } from "./WebRtcProtocol";
import { debugLog } from "@/shared/utils/debugLog";

/**
 * ProtocolManager — unified transport layer.
 *
 * Strategy:
 *   - PRIMARY: WsProtocol (always active — control + fallback tile delivery)
 *   - UPGRADE:  WebRtcProtocol (tiles only, when enableWebRTC = true)
 *   - FALLBACK: auto-reverts to WS on DC fail/close
 *
 * Interface (same as BaseProtocol):
 *   on / off / emit / connect / disconnect / type / connected
 *
 * Listeners registered via on() receive events from BOTH transports.
 * emit() always routes through WS (control events).
 */
export class ProtocolManager {
  constructor(wsConfig, rtcConfig) {
    this._wsConfig = wsConfig;
    this._rtcConfig = rtcConfig;

    this._ws = null;
    this._rtc = null;
    this._rtcActive = false;

    // Unified listener bus: Map<event, Set<handler>>
    this._listeners = new Map();

    // Proxy fn per event for WS socket (for clean removal)
    this._wsProxies = new Map();

    this._type = "ws";
    this._connected = false;

    // Expose socket ref for WebRtcProtocol signaling
    this.socketRef = { current: null };
  }

  get type() { return this._type; }
  get connected() { return this._connected; }
  get connectionMode() { return this._connectionMode || "tunnel"; }

  /**
   * Subscribe to events from any transport.
   * WS events are proxied from socket; DC events are dispatched by WebRtcProtocol.
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
      // Proxy WS socket event into unified bus
      const proxy = (...args) => {
        if (event === "tiles-data" && args[0] && !args[0].transport) args[0].transport = "ws";
        this._dispatch(event, ...args);
      };
      this._wsProxies.set(event, proxy);
      this._ws?.socket?.on(event, proxy);
    }
    this._listeners.get(event).add(handler);
  }

  off(event, handler) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this._listeners.delete(event);
      const proxy = this._wsProxies.get(event);
      if (proxy) {
        this._ws?.socket?.off(event, proxy);
        this._wsProxies.delete(event);
      }
    }
  }

  /** Control events always go via WS */
  emit(event, data) {
    this._ws?.emit(event, data);
  }

  connect() {
    this._ws = new WsProtocol({
      localIp: this._wsConfig.localIp,
      ...this._wsConfig,
      onConnect: (socket) => {
        this._connected = true;
        this._type = "ws";
        this._connectionMode = this._ws.connectionMode;
        this.socketRef.current = socket;

        // Re-attach existing proxies to new socket (tunnel reconnect case)
        for (const [event, proxy] of this._wsProxies.entries()) {
          socket.on(event, proxy);
        }

        // Start WebRTC upgrade in background
        if (this._rtcConfig?.enableWebRTC) {
          debugLog("transport", "[pm] ws connected → start rtc upgrade");
          this._connectRtc();
        }

        this._wsConfig.onConnect?.(socket);
      },
      onDisconnect: (reason) => {
        debugLog("transport", `[pm] ws disconnect reason=${reason} → stop rtc`);
        this._connected = false;
        this._type = "ws";
        this._stopRtc();
        this.socketRef.current = null;
        this._wsConfig.onDisconnect?.(reason);
      },
      onRetryStatus: this._wsConfig.onRetryStatus
    });

    this._ws.connect();
  }

  disconnect() {
    this._stopRtc();
    this._ws?.disconnect();
    this._ws = null;
    this._connected = false;
    this._type = "ws";
    this.socketRef.current = null;
    this._listeners.clear();
    this._wsProxies.clear();
  }

  // ─── WebRTC upgrade ────────────────────────────────────────────────────────

  _connectRtc() {
    this._stopRtc();

    this._rtc = new WebRtcProtocol({
      socketRef: this.socketRef,
      apiKey: this._rtcConfig.apiKey,
      enableTurn: this._rtcConfig.enableTurn,
      onConnect: (via) => {
        this._rtcActive = true;
        this._type = via;
        // Forward DC "tiles-data" into unified bus AND fire socket listeners directly
        // (consumers register handlers on raw socket via socketRef.current.on)
        this._rtc.on("tiles-data", (data) => {
          this._dispatch("tiles-data", data);
          const sock = this.socketRef.current;
          const fns = sock?.listeners?.("tiles-data");
          if (fns?.length) for (const fn of fns) fn(data);
        });
        this._rtcConfig.onUpgrade?.(via);
      },
      onDisconnect: (reason) => {
        debugLog("transport", `[pm] rtc disconnect reason=${reason}`);
        this._rtcActive = false;
        this._type = "ws";
        // Only signal WS fallback when DC never opened
        if (reason !== "dc-closed") this._rtcConfig.onFallback?.("ws");
      }
    });

    this._rtc.connect();
  }

  _stopRtc() {
    this._rtc?.disconnect();
    this._rtc = null;
    this._rtcActive = false;
  }

  _dispatch(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const handler of set) handler(...args);
  }
}
