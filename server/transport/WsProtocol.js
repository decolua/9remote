import { BaseProtocol } from "./BaseProtocol.js";

/**
 * WsProtocol — socket.io transport adapter.
 * All events go through socket.emit (JSON over WebSocket).
 */
export class WsProtocol extends BaseProtocol {
  constructor(socket) {
    super();
    this._socket = socket;
  }

  get type() { return "ws"; }
  isReady() { return this._socket.connected; }
  emit(event, data) { this._socket.emit(event, data); }
  // WS doesn't send raw binary frames — no-op
  sendBinary(_chunks) {}
}
