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

    // socket.io keeps emitting connect_error after a successful connect, and a
    // late one would report failure for a socket that is actually up (the PM
    // then schedules a needless retry). One settle per attempt.
    let settled = false;
    socket.once("connect", () => { if (settled) return; settled = true; onSocket(socket, "tunnel"); });
    socket.once("connect_error", () => { if (settled) return; settled = true; onFail?.(); });
  }
}
