import { io } from "socket.io-client";
import { freshAuth } from "./freshAuth";

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
    // Mode label follows the ENDPOINT, not this class's name: a host-served
    // page connects to its own origin here, which IS the local carrier.
    const mode = this._tunnelUrl === window.location.origin ? "local" : "tunnel";
    const socket = io(url, {
      ...DEFAULT_SOCKET_OPTIONS,
      ...this._socketOptions,
      path: "/socket.io",
      // Function form: socket.io calls it per (re)connect, so a TAIL that
      // arrived mid-session (enrollment) is picked up without a fresh mount.
      // socket.io waits on this callback, so the seal can be computed here.
      auth: (cb) => { freshAuth(this._socketOptions.auth, mode).then(cb); }
    });

    // socket.io keeps emitting connect_error after a successful connect, and a
    // late one would report failure for a socket that is actually up (the PM
    // then schedules a needless retry). One settle per attempt.
    let settled = false;
    socket.once("connect", () => { if (settled) return; settled = true; onSocket(socket, mode); });
    socket.once("connect_error", () => { if (settled) return; settled = true; onFail?.(); });
  }
}
