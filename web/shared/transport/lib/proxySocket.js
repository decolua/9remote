// Persistent proxy socket — emit always routed through PM (auto fallback to RTC).
// on/off delegate to the current raw socket and survive WS disconnect; PM re-binds
// the tracked listeners to each fresh raw socket after a reconnect.
// Extracted verbatim from ProtocolManager.
//
// pm must provide: _anyAdapterReady(), _sendControl(event, args), _rawSocket
export function createProxySocket(pm) {
  // Tracks listeners registered via proxy.on — PM uses this to:
  //   1) Re-attach to new raw socket after reconnect
  //   2) Manually invoke when RTC dispatches event (raw socket may be down)
  const proxyListeners = new Map(); // event → Set<handler>

  return {
    _proxyListeners: proxyListeners,
    get connected() { return pm._anyAdapterReady(); },
    get id() { return pm._rawSocket?.id || null; },
    emit(event, ...args) {
      pm._sendControl(event, args);
    },
    on(event, handler) {
      if (!proxyListeners.has(event)) proxyListeners.set(event, new Set());
      proxyListeners.get(event).add(handler);
      pm._rawSocket?.on(event, handler);
    },
    off(event, handler) {
      proxyListeners.get(event)?.delete(handler);
      pm._rawSocket?.off(event, handler);
    },
    once(event, handler) {
      // Track via proxyListeners so RTC dispatch invokes it even before the
      // raw socket is bound (RTC-first). fired guard prevents double fire.
      let fired = false;
      const wrapper = (...args) => {
        if (fired) return;
        fired = true;
        proxyListeners.get(event)?.delete(wrapper);
        pm._rawSocket?.off(event, wrapper);
        try { handler(...args); } catch {}
      };
      if (!proxyListeners.has(event)) proxyListeners.set(event, new Set());
      proxyListeners.get(event).add(wrapper);
      pm._rawSocket?.on(event, wrapper);
    },
    listeners(event) {
      return [...(proxyListeners.get(event) || [])];
    },
    disconnect() {
      pm._rawSocket?.disconnect();
    }
  };
}

/** Re-attach all proxy listeners to a fresh raw socket after reconnect. */
export function rebindProxyListeners(rawSocket, proxySocket) {
  if (!rawSocket || !proxySocket?._proxyListeners) return;
  for (const [event, set] of proxySocket._proxyListeners.entries()) {
    for (const h of set) rawSocket.on(event, h);
  }
}

/** Fire the tracked "connect" listeners directly (carrier rejoin, no raw socket). */
export function fireProxyEvent(proxySocket, event) {
  for (const h of proxySocket?._proxyListeners?.get(event) || []) {
    try { h(); } catch {}
  }
}
