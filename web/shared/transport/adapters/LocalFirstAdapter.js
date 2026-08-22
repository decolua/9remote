import { io } from "socket.io-client";
import { freshAuth } from "./freshAuth";

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
    // socket.io keeps emitting connect_error after a successful connect (later
    // transport errors), so the local probe's error handler could fire once the
    // local socket had already won — spawning a pointless second socket to the
    // tunnel. One settle per connect attempt.
    let settled = false;
    const win = (socket, mode) => { if (settled) { try { socket.disconnect(); } catch {} return; } settled = true; onSocket(socket, mode); };
    const fail = () => { if (settled) return; settled = true; onFail?.(); };
    const mkUrl = (base) => this._namespace ? `${base}${this._namespace}` : base;
    const mkOpts = (mode) => ({
      ...DEFAULT_SOCKET_OPTIONS,
      ...this._socketOptions,
      path: "/socket.io",
      // Function form: socket.io calls it per (re)connect, so a TAIL that
      // arrived mid-session (enrollment) is picked up without a fresh mount.
      auth: (cb) => cb(freshAuth(this._socketOptions.auth, mode))
    });

    const connectTunnel = () => {
      const socket = io(mkUrl(this._tunnelUrl), mkOpts("tunnel"));
      socket.once("connect", () => win(socket, "tunnel"));
      socket.once("connect_error", () => fail());
    };

    // HTTPS pages block ws:// (Mixed Content) — skip local probe, use tunnel directly
    if (window.location.protocol === "https:") {
      connectTunnel();
      return;
    }

    const localSocket = io(mkUrl(`http://${this._localIp}`), mkOpts("local"));
    localSocket.once("connect", () => win(localSocket, "local"));
    localSocket.once("connect_error", () => {
      // Only fall back while the local probe is still the live attempt — a late
      // error after it connected must not open a second socket to the tunnel.
      if (settled) return;
      localSocket.disconnect();
      connectTunnel();
    });
  }
}
