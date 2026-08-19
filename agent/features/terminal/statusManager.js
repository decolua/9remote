// AI agent status state machine (idle / working / blocked / done).
// Replaces the old binary notificationManager. One session = one state.
// In-memory only: state resets on agent restart; hooks re-fire working on next prompt.

export const STATES = Object.freeze({
  IDLE: "idle",
  WORKING: "working",
  BLOCKED: "blocked",
  DONE: "done",
});

// A working session is considered live while either hook events or PTY output keeps arriving.
// Reaper clears entries idle beyond this TTL so a crashed/stuck agent can't pin "working" forever.
export const WORKING_TTL_MS = 60_000;
const REAPER_INTERVAL_MS = 15_000;

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

// Claude Code conversation id per 9Remote session (captured by the claude hook).
// Kept apart from the state map so the reaper can't clear it — it powers exact resume.
const claudeSessionIds = new Map();

export function setClaudeSessionId(sessionId, csid) {
  if (!sessionId || !csid) return;
  claudeSessionIds.set(sessionId, csid);
}

export function getClaudeSessionId(sessionId) {
  return claudeSessionIds.get(sessionId) || null;
}

export function applyEvent({ type, sessionId, tool, message } = {}) {
  if (!sessionId) return null;
  const state = TYPE_TO_STATE[type] || STATES.IDLE;
  const prev = sessionStatus.get(sessionId);

  // done only makes sense after working/blocked — ignore a stray done on idle
  if (state === STATES.DONE && (!prev || prev.state === STATES.IDLE)) return prev || null;

  // No-op transition: keep timestamp, avoid spurious broadcasts.
  if (prev && prev.state === state && prev.tool === tool) return prev;

  const entry = {
    state, tool: tool || prev?.tool, since: Date.now(), message: message ?? undefined,
    ...(state === STATES.WORKING ? { expiresAt: Date.now() + WORKING_TTL_MS } : {}),
  };
  sessionStatus.set(sessionId, entry);
  return entry;
}

export function setStatus(sessionId, entry) {
  if (!sessionId) return;
  if (!entry) { sessionStatus.delete(sessionId); return; }
  const meta = { ...entry, since: Date.now() };
  if (meta.state === STATES.WORKING) meta.expiresAt = Date.now() + WORKING_TTL_MS;
  sessionStatus.set(sessionId, meta);
}

// Refresh the working TTL — called on live PTY output so a thinking/streaming agent
// is never reaped while it's still producing. No-op for non-working sessions.
export function touchWorking(sessionId) {
  if (!sessionId) return;
  const entry = sessionStatus.get(sessionId);
  if (entry?.state !== STATES.WORKING) return;
  entry.expiresAt = Date.now() + WORKING_TTL_MS;
}

// Periodically drop working entries whose TTL expired (agent crashed / hook never fired).
// broadcast(sessionId) is invoked per cleared session so clients flip back to idle.
export function startReaper(broadcast) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessionStatus) {
      if (entry.state !== STATES.WORKING) continue;
      if (entry.expiresAt != null && entry.expiresAt <= now) {
        sessionStatus.delete(id);
        if (typeof broadcast === "function") { try { broadcast(id); } catch {} }
      }
    }
  }, REAPER_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

export function getStatus(sessionId) {
  return sessionStatus.get(sessionId) || null;
}

export function getStatuses() {
  const out = {};
  for (const [id, entry] of sessionStatus) out[id] = entry;
  // Attach claude ids for sessions that have no live state entry too (idle tab)
  for (const [id, csid] of claudeSessionIds) {
    out[id] = out[id] ? { ...out[id], claudeSessionId: csid } : { claudeSessionId: csid };
  }
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
