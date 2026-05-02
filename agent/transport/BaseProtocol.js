import { ADAPTER_STATE } from "../lib/transportConstants.js";

/**
 * BaseProtocol — server-side adapter contract.
 *
 * Static metadata (declare in subclass): id, capabilities, priority
 *
 * Events: "stateChange"(state), "message"({event,data}), "binary"(buf), "error"(err)
 * Methods: connect(ctx), disconnect(), send(channel, payload)
 */
export class BaseProtocol {
  static id = "base";
  static capabilities = { control: false, binary: false, signaling: "none" };
  static priority = { control: 0, binary: 0 };

  constructor() {
    this._listeners = new Map();
    this._state = ADAPTER_STATE.idle;
  }

  get state() { return this._state; }
  get ready() { return this._state === ADAPTER_STATE.open; }

  supports(channel) {
    return Boolean(this.constructor.capabilities[channel]);
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  _emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const h of set) h(...args);
  }

  _setState(next) {
    if (this._state === next) return;
    this._state = next;
    this._emit("stateChange", next);
  }

  connect(_ctx) { throw new Error("Not implemented: connect"); }
  disconnect() { throw new Error("Not implemented: disconnect"); }
  send(_channel, _payload) { throw new Error("Not implemented: send"); }
}
