import { EventEmitter } from "events";
import { CONNECTION_STATE, AUTH_EVENTS } from "../lib/connectionConstants.js";

/**
 * One device's presence on this agent — the layer that was missing.
 *
 * Before this, the connection WAS a carrier: an RTC peer owned a VirtualSocket
 * that hosted every handler, and the tunnel had to attach itself to that as a
 * latecomer. Two carriers, two lifecycles, two of every rule — and a rule added
 * to one of them was a bug waiting in the other. Approval gates, event
 * blocking, teardown and bookkeeping each existed twice, and each was fixed
 * separately, more than once.
 *
 * Here the device is the subject and carriers are attachments. A carrier is
 * anything satisfying BaseProtocol: the tunnel, RTC, or a protocol added years
 * from now. Whichever arrives first opens the connection; the rest join it. None
 * of them decides anything.
 *
 * The state machine only ever moves forward:
 *
 *   authenticating ──key proven──► awaitingHost ──host allows──► active
 *          │                             │                          │
 *          └──────────── refused / torn down ─────────────────► closed
 *
 * Nothing but auth traffic crosses a connection that is not active, which is the
 * single rule that used to be spelled out per carrier (socket.use for one,
 * a patched listeners() for the other).
 */
export class Connection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.deviceId  identity; carriers come and go, this does not
   * @param {string} [opts.peerId]  "deviceId:tab" when a carrier is per-tab
   * @param {string} [opts.apiKey]
   */
  constructor({ deviceId, peerId = null, apiKey = null }) {
    super();
    this.setMaxListeners(0);
    this.deviceId = deviceId;
    this.peerId = peerId || deviceId;
    this.apiKey = apiKey;
    this.createdAt = Date.now();
    this.data = {};
    this._state = CONNECTION_STATE.authenticating;
    this._carriers = new Map(); // id → carrier (BaseProtocol-shaped)
  }

  get state() { return this._state; }
  get active() { return this._state === CONNECTION_STATE.active; }
  get closed() { return this._state === CONNECTION_STATE.closed; }

  /** Carrier ids currently attached, in attach order. */
  get carrierIds() { return [...this._carriers.keys()]; }

  /** True while at least one attached carrier can actually move bytes. */
  get connected() {
    for (const c of this._carriers.values()) if (c?.ready) return true;
    return false;
  }

  // ── Carriers ──────────────────────────────────────────────────────────────

  /**
   * Attach a transport. The one door: tunnel, RTC and anything later all enter
   * here, so no protocol needs its own path through the lifecycle.
   * Idempotent per id — a reconnecting carrier replaces its predecessor rather
   * than stacking a second one.
   */
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

  // ── The one gate on traffic ───────────────────────────────────────────────

  /**
   * May this event cross the connection right now?
   *
   * An inactive connection carries auth and nothing else. This is deliberately the
   * ONLY place that rule lives: expressing it per carrier is what let an
   * RTC-only session answer getSessions while the host had not been asked.
   */
  allows(event) {
    if (this.active) return true;
    if (this.closed) return false;
    return AUTH_EVENTS.has(event);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Record that the KEY is proven. Moves authenticating → awaitingHost, and no
   * further: proving the key answers "is this the right key", never "does the
   * host allow this device".
   */
  keyProven() {
    if (this._state !== CONNECTION_STATE.authenticating) return false;
    return this._transition(CONNECTION_STATE.awaitingHost, "key-proven");
  }

  /**
   * The host allows this device (or already did). Only legal once the key is
   * proven — an approval must never be able to stand in for the proof, which
   * is why this refuses to skip a state rather than jumping straight to active.
   */
  hostAllowed() {
    if (this._state !== CONNECTION_STATE.awaitingHost) return false;
    return this._transition(CONNECTION_STATE.active, "host-allowed");
  }

  /** Terminal. Carriers are detached; the reason travels with the event. */
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
