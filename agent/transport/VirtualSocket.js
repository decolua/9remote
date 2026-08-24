import { EventEmitter } from "events";


// Minimal socket.io-socket surface so feature handlers run unchanged over an
// RTC-only session (no tunnel). PM.attachAsBus() wraps emit → routes via RTC.
// When the tunnel later brings a real socket, PM.attachSocket() adds WS as
// fallback; this object stays the handler host for the whole session.
export class VirtualSocket extends EventEmitter {
  constructor({ deviceId, peerId, apiKey }) {
    super();
    this.setMaxListeners(0);
    this.isVirtual = true;
    // Unique per tab — resource maps (remote clients, transfers) key on socket.id.
    this.id = `rtc-${peerId || deviceId}`;
    this.peerId = peerId || deviceId;
    this.connected = true;
    this.data = {};
    this.handshake = { auth: { deviceId, apiKey }, headers: {}, address: "rtc" };
    // How this socket identifies itself as a carrier. Callers ask the socket
    // rather than testing isVirtual, so adding a protocol later means teaching
    // it to answer these — not hunting for every `if` that assumed two.
    this.carrier = { id: "rtc", ip: "rtc", pendingId: `rtc-${peerId || deviceId}` };
    // socket.broadcast.emit(...) — no peers on a virtual session
    this.broadcast = { emit: () => true };
    this._onAny = [];
  }

  onAny(fn) { this._onAny.push(fn); return this; }
  offAny(fn) { this._onAny = this._onAny.filter((f) => f !== fn); return this; }

  /**
   * The unapproved-event guard, which socket.io gives a real socket through
   * socket.use(). PM dispatches an RTC event by calling listeners(event), so
   * this is where it has to live: without it an RTC-only session answered
   * getSessions, getWorkspaces and the rest while the device was still waiting
   * for the host — which is how a reload walked straight into the workspace.
   *
   * Auth is the exception, and the only one: those events ARE how a device
   * stops being unapproved.
   */
  listeners(event) {
    const all = super.listeners(event);
    // Same question the tunnel asks through socket.use — asked of the session,
    // not of this object, so the rule cannot drift between the two protocols.
    const session = this.data?.session;
    if (!session) return all;
    return session.allows(event) ? all : [];
  }

  // Feed an inbound event to handlers (RTC dispatch goes through PM directly,
  // this exists so onAny consumers — file explorer binary — still see traffic).
  dispatchAny(event, data) {
    for (const fn of this._onAny) { try { fn(event, data); } catch {} }
  }

  disconnect() {
    this.connected = false;
    // PM.attachAsBus() replaces emit with an outbound sender — fire local
    // listeners through the original EventEmitter.emit instead.
    EventEmitter.prototype.emit.call(this, "disconnect", "rtc-session-closed");
    return this;
  }
}
