import { EventEmitter } from "events";
import { CONNECTION_STATE, AUTH_EVENTS } from "../lib/connectionConstants.js";

// Device connection model managing multi-carrier lifecycle and auth state machine.
export class Connection extends EventEmitter {
  constructor({ deviceId, peerId = null, apiKey = null }) {
    super();
    this.setMaxListeners(0);
    this.deviceId = deviceId;
    this.peerId = peerId || deviceId;
    this.apiKey = apiKey;
    this.createdAt = Date.now();
    this.data = {};
    this._state = CONNECTION_STATE.authenticating;
    this._carriers = new Map();
  }

  get state() { return this._state; }
  get active() { return this._state === CONNECTION_STATE.active; }
  get closed() { return this._state === CONNECTION_STATE.closed; }

  get carrierIds() { return [...this._carriers.keys()]; }

  get connected() {
    for (const c of this._carriers.values()) if (c?.ready) return true;
    return false;
  }

  // Attach carrier idempotently; replaces existing carrier with same id.
  attach(id, carrier) {
    if (this.closed) return false;
    const prev = this._carriers.get(id);
    if (prev && prev !== carrier) this._detachOne(id, prev);
    this._carriers.set(id, carrier);
    this.emit("carrierAttached", id, carrier);
    return true;
  }

  detach(id) {
    const carrier = this._carriers.get(id);
    if (!carrier) return false;
    this._detachOne(id, carrier);
    return true;
  }

  _detachOne(id, carrier) {
    this._carriers.delete(id);
    this.emit("carrierDetached", id, carrier);
  }

  hasCarrier(id) { return this._carriers.has(id); }
  carrier(id) { return this._carriers.get(id) || null; }

  // Only auth events are allowed across an inactive connection.
  allows(event) {
    if (this.active) return true;
    if (this.closed) return false;
    return AUTH_EVENTS.has(event);
  }

  keyProven() {
    if (this._state !== CONNECTION_STATE.authenticating) return false;
    return this._transition(CONNECTION_STATE.awaitingHost, "key-proven");
  }

  // Transition to active state once key is proven and host allows device.
  hostAllowed() {
    if (this._state !== CONNECTION_STATE.awaitingHost) return false;
    return this._transition(CONNECTION_STATE.active, "host-allowed");
  }

  close(reason = "closed") {
    if (this.closed) return false;
    for (const [id, carrier] of [...this._carriers]) this._detachOne(id, carrier);
    return this._transition(CONNECTION_STATE.closed, reason);
  }

  _transition(next, reason) {
    const from = this._state;
    this._state = next;
    this.emit("state", { from, to: next, reason, deviceId: this.deviceId });
    return true;
  }

  toJSON() {
    return {
      deviceId: this.deviceId,
      peerId: this.peerId,
      state: this._state,
      carriers: this.carrierIds,
      createdAt: this.createdAt
    };
  }
}
