import { io } from "socket.io-client";

const DEFAULT_SOCKET_OPTIONS = {
  transports: ["websocket"],
  reconnection: false
};

/**
 * LocalFirstAdapter — probes local LAN first, falls back to tunnel on error.
 * No timeout — relies on connect_error which fires immediately on TCP failure.
 */
export class LocalFirstAdapter {
  constructor({ tunnelUrl, localIp, namespace = "", socketOptions = {} }) {
    this._tunnelUrl = tunnelUrl;
    this._localIp = localIp;
    this._namespace = namespace;
    this._socketOptions = socketOptions;
  }

  connect({ onSocket, onFail }) {
    const mkUrl = (base) => this._namespace ? `${base}${this._namespace}` : base;
    const mkOpts = (mode) => ({
      ...DEFAULT_SOCKET_OPTIONS,
      ...this._socketOptions,
      path: "/socket.io",
      auth: { ...this._socketOptions.auth, connectionMode: mode }
    });

    const connectTunnel = () => {
      const socket = io(mkUrl(this._tunnelUrl), mkOpts("tunnel"));
      socket.once("connect", () => onSocket(socket, "tunnel"));
      socket.once("connect_error", () => onFail?.());
    };

    // HTTPS pages block ws:// (Mixed Content) — skip local probe, use tunnel directly
    if (window.location.protocol === "https:") {
      connectTunnel();
      return;
    }

    const localSocket = io(mkUrl(`http://${this._localIp}`), mkOpts("local"));
    localSocket.once("connect", () => onSocket(localSocket, "local"));
    localSocket.once("connect_error", () => { localSocket.disconnect(); connectTunnel(); });
  }
}
