// Active protocol registry — PMs survive socket disconnect (grace period for RTC fallback)
const active = new Set();

export function registerProtocol(pm) { active.add(pm); }
export function unregisterProtocol(pm) { active.delete(pm); }

// Live carrier counts for the UI transport badges
export function getTransportStats() {
  let rtcPeers = 0, wsPeers = 0;
  for (const pm of active) {
    if (pm._adapters?.get("rtc")?.ready) rtcPeers++;
    if (pm._adapters?.get("ws")?.ready) wsPeers++;
  }
  return { rtcPeers, wsPeers };
}

// Broadcast event to all active PMs (routes via best adapter — RTC if WS down)
export function broadcast(_io, event, data) {
  for (const pm of active) {
    // Skip PMs with no ready adapter — avoids buffering into dying/orphan PMs
    if (!pm.hasReadyAdapter?.()) continue;
    try { pm.emit(event, data); } catch {}
  }
}
