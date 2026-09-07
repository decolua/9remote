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
      auth: (cb) => { freshAuth(this._socketOptions.auth, mode).then(cb); }
    });

    const connectTunnel = () => {
      // Mode label follows the ENDPOINT, not the code path: connecting to the
      // page's own origin (agent-served workspace) IS the local carrier, even
      // though it rides this function rather than the localIp probe.
      const mode = this._tunnelUrl === window.location.origin ? "local" : "tunnel";
      const socket = io(mkUrl(this._tunnelUrl), mkOpts(mode));
      socket.once("connect", () => win(socket, mode));
      socket.once("connect_error", () => fail());
    };

    // HTTPS pages block ws:// (Mixed Content), and no localIp means no probe
    // target — both go straight to the tunnel URL (which in local mode IS the
    // loopback origin, so nothing is lost by skipping the probe).
    if (!this._localIp || window.location.protocol === "https:") {
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
