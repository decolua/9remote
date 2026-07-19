// AI agent status state machine (idle / working / blocked / done).
// Replaces the old binary notificationManager. One session = one state.
// In-memory only: state resets on agent restart; hooks re-fire working on next prompt.

export const STATES = Object.freeze({
  IDLE: "idle",
  WORKING: "working",
  BLOCKED: "blocked",
  DONE: "done",
});

// Back-compat: legacy hook event types from /api/notify → internal state.
export const TYPE_TO_STATE = Object.freeze({
  stop: STATES.DONE,
  notification: STATES.BLOCKED,
  working: STATES.WORKING,
  done: STATES.DONE,
  blocked: STATES.BLOCKED,
  idle: STATES.IDLE,
});

// sessionStatus: Map<sessionId, { state, tool, since, message? }>
const sessionStatus = new Map();
const clearCallbacks = new Set();

export function applyEvent({ type, sessionId, tool, message } = {}) {
  if (!sessionId) return null;
  const state = TYPE_TO_STATE[type] || STATES.IDLE;
  const prev = sessionStatus.get(sessionId);

  // done only makes sense after working/blocked — ignore a stray done on idle
  if (state === STATES.DONE && (!prev || prev.state === STATES.IDLE)) return prev || null;

  // No-op transition: keep timestamp, avoid spurious broadcasts.
  if (prev && prev.state === state && prev.tool === tool) return prev;

  const entry = { state, tool: tool || prev?.tool, since: Date.now(), message: message ?? undefined };
  sessionStatus.set(sessionId, entry);
  return entry;
}

export function setStatus(sessionId, entry) {
  if (!sessionId) return;
  if (!entry) { sessionStatus.delete(sessionId); return; }
  sessionStatus.set(sessionId, { ...entry, since: Date.now() });
}

export function getStatus(sessionId) {
  return sessionStatus.get(sessionId) || null;
}

export function getStatuses() {
  const out = {};
  for (const [id, entry] of sessionStatus) out[id] = entry;
  return out;
}

export function clearStatus(sessionId) {
  if (!sessionId) return false;
  const entry = sessionStatus.get(sessionId);
  // Only clear DONE (mark as seen → idle). working/blocked stay — focusing or typing into a
  // running/blocked pane does not stop the agent or resolve its pending input.
  if (!entry || entry.state !== STATES.DONE) return false;
  sessionStatus.delete(sessionId);
  for (const cb of clearCallbacks) { try { cb(sessionId); } catch {} }
  return true;
}

export function onClearStatus(cb) {
  clearCallbacks.add(cb);
  return () => clearCallbacks.delete(cb);
}

// Back-compat shim for notificationManager.addNotification / getNotifications callers.
export function addNotification(sessionId, notification) {
  if (!sessionId || !notification) return;
  applyEvent({ type: notification.type, sessionId, tool: notification.tool });
}
export function getNotifications() {
  // Legacy UI checked truthiness of notifications[id]; expose done/blocked as truthy.
  const out = {};
  for (const [id, entry] of sessionStatus) {
    if (entry.state === STATES.DONE || entry.state === STATES.BLOCKED) {
      out[id] = { sessionId: id, type: entry.state, tool: entry.tool, timestamp: entry.since };
    }
  }
  return out;
}
export function clearNotification(sessionId) { clearStatus(sessionId); }
