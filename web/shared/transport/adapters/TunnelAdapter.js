import { io } from "socket.io-client";

const DEFAULT_SOCKET_OPTIONS = {
  transports: ["websocket"],
  reconnection: false,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
};

/**
 * TunnelAdapter — connects directly to tunnel URL.
 * Simple wrapper: create socket → call onSocket or onFail.
 */
export class TunnelAdapter {
  constructor({ tunnelUrl, namespace = "", socketOptions = {} }) {
    this._tunnelUrl = tunnelUrl;
    this._namespace = namespace;
    this._socketOptions = socketOptions;
  }

  connect({ onSocket, onFail }) {
    const url = this._namespace ? `${this._tunnelUrl}${this._namespace}` : this._tunnelUrl;
    const socket = io(url, {
      ...DEFAULT_SOCKET_OPTIONS,
      ...this._socketOptions,
      path: "/socket.io",
      auth: { ...this._socketOptions.auth, connectionMode: "tunnel" }
    });

    socket.once("connect", () => onSocket(socket, "tunnel"));
    socket.once("connect_error", () => onFail?.());
  }
}
