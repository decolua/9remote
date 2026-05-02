// Active protocol registry — PMs survive socket disconnect (grace period for RTC fallback)
const active = new Set();

export function registerProtocol(pm) { active.add(pm); }
export function unregisterProtocol(pm) { active.delete(pm); }

// Broadcast event to all active PMs (routes via best adapter — RTC if WS down)
export function broadcast(_io, event, data) {
  for (const pm of active) {
    try { pm.emit(event, data); } catch {}
  }
}
