import { EventEmitter } from "events";


// HostBus — the host's handler host, mirroring the web's ClientBus. An
// RTC-first session has no socket.io socket, so feature handlers need
// something to register on; PM.attachAsBus() wraps emit → routes via RTC,
// and PM.attachSocket() adds WS as a fallback when the tunnel comes up.
//
// Step one of the registry unification is done: PM asks the host questions
// (defersWsAdapter, carrier) instead of branching on isVirtual, and identity
// reads go through data.auth. What remains of the socket.io emulation —
// .handshake, .broadcast, onAny — exists only because feature handlers still
// read it; each of those callsites migrates to data.auth / broadcast.js, and
// when the last one is gone this class collapses to a plain listener registry.
export class HostBus extends EventEmitter {
  /** Hosts the session so the PM can ask it instead of testing a type flag:
   *  true = the PM's WS adapter must attach LATE (tunnel joined RTC), false =
   *  a socket.io socket IS the WS adapter from the start. */
  defersWsAdapter = true;
  constructor({ deviceId, peerId, apiKey }) {
    super();
    this.setMaxListeners(0);
    // Unique per tab — resource maps (remote clients, transfers) key on socket.id.
    this.id = `rtc-${peerId || deviceId}`;
    this.peerId = peerId || deviceId;
    this.connected = true;
    this.data = {};
    // Normalized identity — features read data.auth first; .handshake below is
    // the socket.io spelling kept so legacy handlers keep working.
    this.data.auth = { deviceId, apiKey };
    this.handshake = { auth: { deviceId, apiKey }, headers: {}, address: "rtc" };
    // How this socket identifies itself as a carrier. Callers ask the socket
    // rather than testing a type flag, so adding a protocol later means teaching
    // it to answer these — not hunting for every `if` that assumed two.
    this.carrier = { id: "rtc", ip: "rtc", pendingId: `rtc-${peerId || deviceId}` };
    // socket.broadcast.emit(...) — a virtual session has no other peers
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
   * stops being unapproved. Reads the same session the WS guard does
   * (data.conn) so the rule cannot drift between the two protocols.
   */
  listeners(event) {
    const all = super.listeners(event);
    const conn = this.data?.conn;
    if (!conn) return all;
    return conn.allows(event) ? all : [];
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

// Backward-compatible alias for in-flight migrations
export const AgentBus = HostBus;
