// ClientBus — the client's single handler host, mirroring the host's HostBus.
//
// It presents the socket.io surface the app is written against (on/off/once/emit/
// connected/id/disconnect) while owning the ONLY registry of listeners. PM dispatches
// into it whichever carrier delivered the message, so a carrier swap changes nothing
// here: there is no second copy on a socket to re-attach, and no map to invoke by
// hand when there is no socket at all.
//
// pm must provide: _anyAdapterReady(), _sendControl(event, args), _rawSocket
export function createClientBus(pm) {
  // event → handler[]. An ARRAY, not a Set: socket.io and EventEmitter both let the
  // same function register twice and then deliver to it twice, and off() removes one
  // copy. A Set would silently dedupe — two mounted panes sharing a handler would
  // collapse into one delivery.
  const listeners = new Map();

  const add = (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
  };

  // Removes ONE registration: the handler itself, or the once-wrapper standing in
  // for it (a pane that cancels a pending once passes the original function).
  const remove = (event, handler) => {
    const arr = listeners.get(event);
    if (!arr) return;
    const i = arr.findIndex((h) => h === handler || h._original === handler);
    if (i !== -1) arr.splice(i, 1);
  };

  return {
    // Exposed for PM (dispatch) and for tests; not part of the socket surface.
    _listeners: listeners,

    get connected() { return pm._anyAdapterReady(); },
    // Only a WS session has a socket id; an RTC-only session legitimately has none.
    get id() { return pm._rawSocket?.id || null; },

    emit(event, ...args) {
      pm._sendControl(event, args);
    },

    on(event, handler) {
      add(event, handler);
    },

    off(event, handler) {
      remove(event, handler);
    },

    once(event, handler) {
      // The wrapper is what the registry holds, so off(handler) has to find it
      // too — a pane that cancels a pending once must not leave it armed.
      const wrapper = (...args) => {
        remove(event, wrapper);
        handler(...args);
      };
      wrapper._original = handler;
      add(event, wrapper);
    },

    listeners(event) {
      return [...(listeners.get(event) || [])];
    },

    /** Deliver an event to this bus's listeners. Called by PM for every carrier.
     *  Iterates a snapshot: handlers unmount panes (and therefore call off) from
     *  inside the loop, and a live Set would skip the sibling that follows.
     *  One handler throwing must not stop the rest — a single broken pane cannot
     *  be allowed to block a rejoin for every other pane. */
    dispatch(event, args = []) {
      const arr = listeners.get(event);
      if (!arr?.length) return;
      for (const h of [...arr]) {
        // Removed by an earlier handler in this same pass — respect that.
        if (!arr.includes(h)) continue;
        try { h(...args); } catch {}
      }
    },

    /** Drop every listener. Called on PM teardown: these used to live on the
     *  socket.io socket and die with it, so nothing had to release them. They live
     *  here now, and a discarded PM holding pane handlers holds their closures too. */
    clear() {
      listeners.clear();
    },

    disconnect() {
      pm._rawSocket?.disconnect();
    },

    /** Probe and reconnect a ready-but-silent WS (zombie); true when kicked. */
    kickWsZombie(reason) {
      return pm.kickWsZombie(reason);
    }
  };
}
