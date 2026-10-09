import { BaseProtocol } from "./BaseProtocol.js";
import { ADAPTER_STATE, CHANNELS, WS_BINARY_BACKPRESSURE_BYTES } from "../lib/transportConstants.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("wsProtocol");

/**
 * WsProtocol — server-side socket.io adapter.
 * Wraps an existing per-connection socket. Channels: control (emit), binary (tiles-bin-v2).
 */
export class WsProtocol extends BaseProtocol {
  static id = "ws";
  static capabilities = { control: true, binary: true, file: true, mobile: true, browser: true, signaling: "ws" };
  static priority = { control: 100, binary: 10, file: 10, mobile: 10, browser: 10 };

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

    // Capture full args (incl ack callback) — onAny fires after onevent pushes
    // the ack fn into args, so HostBus-hosted handlers get their callback over WS.
    ctx.socket.onAny?.((event, ...args) => this._emit("message", { event, data: args[0], args, source: "ws" }));
  }

  disconnect() {
    this._socket = null;
    this._setState(ADAPTER_STATE.closed);
  }

  // Real WS backpressure: engine.io's transport.writable sticks false forever
  // when a flush callback is lost on a half-open link (socket stays
  // "connected"), so gate on the ws library's buffered bytes instead. Polling
  // transports keep the writable check — there it legitimately toggles.
  _backpressured() {
    const transport = this._socket?.conn?.transport;
    if (!transport) return false;
    if (transport.name === "websocket") {
      const sock = transport.socket;
      const buffered = typeof sock?.getBufferedAmount === "function"
        ? sock.getBufferedAmount()
        : sock?.bufferedAmount ?? 0;
      return buffered > WS_BINARY_BACKPRESSURE_BYTES;
    }
    return transport.writable === false;
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
      // Real backpressure only — see _backpressured(). Caller retries next frame.
      if (this._backpressured()) return false;
      emit("tiles-bin-v2", payload);
      return true;
    }
    if (channel === CHANNELS.browser) {
      if (this._backpressured()) return false;
      emit("browser:tiles-bin", payload);
      return true;
    }
    // No separate lane over WS: mobile video shares the file event, frames are
    // self-tagged and the client routes them by magic (decodeMobileFrame).
    if (channel === CHANNELS.file || channel === CHANNELS.mobile) {
      if (this._backpressured()) return false;
      emit("file-bin", payload);
      return true;
    }
    return false;
  }
}
