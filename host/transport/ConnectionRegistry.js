import { Connection } from "./Connection.js";
import { CONNECTION_STATE } from "../lib/connectionConstants.js";

/**
 * Every device's connection, in one book.
 *
 * There used to be two: socket.io's own socket map for the tunnel, and an
 * rtcSessions Map for RTC peers. Anything that had to act on "this device" —
 * approving it, refusing it, tearing it down — had to walk both and remember
 * that they behaved differently. Every fix to one of them was a fix owed to the
 * other, and that debt is what produced most of the bugs this replaces.
 *
 * Keyed by deviceId because that is the thing being admitted. A device may hold
 * several connections (one per browser tab, keyed by peerId inside), and a
 * verdict about the device applies to all of them at once.
 */
export class ConnectionRegistry {
  constructor() {
    this._byPeer = new Map();    // peerId → Connection
    this._byDevice = new Map();  // deviceId → Set<peerId>
  }

  /** The connection for this peer, creating it if this is its first carrier. */
  open({ deviceId, peerId, apiKey }) {
    const key = peerId || deviceId;
    const existing = this._byPeer.get(key);
    if (existing && !existing.closed) return existing;

    const session = new Connection({ deviceId, peerId: key, apiKey });
    this._byPeer.set(key, session);
    if (!this._byDevice.has(deviceId)) this._byDevice.set(deviceId, new Set());
    this._byDevice.get(deviceId).add(key);
    // Self-eviction: a connection that closes for any reason leaves the book
    // without the closer having to remember to say so. Forgetting to unregister
    // is how stale connections used to keep answering after their carrier died.
    session.on("state", (e) => {
      if (e.to === CONNECTION_STATE.closed) this.delete(key);
    });
    return session;
  }

  get(peerId) {
    const s = this._byPeer.get(peerId);
    return s && !s.closed ? s : null;
  }

  /** Every live connection this device holds — one per tab. */
  forDevice(deviceId) {
    const keys = this._byDevice.get(deviceId);
    if (!keys) return [];
    const out = [];
    for (const k of keys) {
      const s = this._byPeer.get(k);
      if (s && !s.closed) out.push(s);
    }
    return out;
  }

  /** Apply a device-wide verdict — the operation both books used to need. */
  closeDevice(deviceId, reason) {
    const sessions = this.forDevice(deviceId);
    for (const s of sessions) s.close(reason);
    return sessions.length;
  }

  delete(peerId) {
    const session = this._byPeer.get(peerId);
    if (!session) return false;
    this._byPeer.delete(peerId);
    const keys = this._byDevice.get(session.deviceId);
    if (keys) {
      keys.delete(peerId);
      if (!keys.size) this._byDevice.delete(session.deviceId);
    }
    return true;
  }

  get size() { return this._byPeer.size; }
  all() { return [...this._byPeer.values()]; }
}
