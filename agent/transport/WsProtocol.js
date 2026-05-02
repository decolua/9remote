import { BaseProtocol } from "./BaseProtocol.js";
import { ADAPTER_STATE, CHANNELS } from "../lib/transportConstants.js";

/**
 * WsProtocol — server-side socket.io adapter.
 * Wraps an existing per-connection socket. Channels: control (emit), binary (tiles-bin-v2).
 */
export class WsProtocol extends BaseProtocol {
  static id = "ws";
  static capabilities = { control: true, binary: true, signaling: "ws" };
  static priority = { control: 100, binary: 10 };

  constructor() {
    super();
    this._socket = null;
  }

  get socket() { return this._socket; }

  /**
   * @param {object} ctx
   * @param {object} ctx.socket — existing socket.io socket
   */
  connect(ctx) {
    this._socket = ctx.socket;
    this._setState(ctx.socket.connected ? ADAPTER_STATE.open : ADAPTER_STATE.connecting);

    ctx.socket.on("connect", () => this._setState(ADAPTER_STATE.open));
    ctx.socket.on("disconnect", () => this._setState(ADAPTER_STATE.closed));

    ctx.socket.onAny?.((event, data) => this._emit("message", { event, data, source: "ws" }));
  }

  disconnect() {
    this._socket = null;
    this._setState(ADAPTER_STATE.closed);
  }

  send(channel, payload) {
    if (!this._socket?.connected) return false;
    // Use raw emit if available to bypass transport routing wrapper
    const emit = this._socket._rawEmit || this._socket.emit.bind(this._socket);
    if (channel === CHANNELS.control) {
      const { event, args = [] } = payload;
      emit(event, ...args);
      return true;
    }
    if (channel === CHANNELS.binary) {
      emit("tiles-bin-v2", payload);
      return true;
    }
    return false;
  }
}
