import { useState, useEffect, useRef } from "preact/hooks";
import { io } from "socket.io-client";
import { LOCAL_UI_DEVICE_ID } from "./constants";
import { AGENT_LABELS } from "./agentLabels";
import { setTauriBadge, showTauriNotification } from "./tauriBridge";

// Single same-origin socket for the local UI.
// Trusted via ephemeral local token (mem-only on server) — resists CSWSH.
let socketSingleton = null;
function getSocket() {
  if (!socketSingleton) {
    socketSingleton = io({
      transports: ["websocket"],
      autoConnect: false,
      auth: { deviceId: LOCAL_UI_DEVICE_ID },
    });
    // Fetch local token (loopback + same-origin guarded), then connect
    fetch("/api/local-token")
      .then((r) => r.json())
      .then((d) => { socketSingleton.auth = { deviceId: LOCAL_UI_DEVICE_ID, localToken: d.localToken }; })
      .catch(() => {})
      .finally(() => socketSingleton.connect());
  }
  return socketSingleton;
}

// Sessions + groups state, kept in sync via socket events (mirrors web flow)
export function useSessions() {
  const socket = getSocket();
  const [connected, setConnected] = useState(socket.connected);
  const [sessions, setSessions] = useState([]);
  const [groups, setGroups] = useState([]);
  // Badge state as a Set of sessionId (web equivalent: `notifications` object in web/shared/hooks/useNotification.js)
  const [finishedIds, setFinishedIds] = useState(() => new Set());
  // Full notification payloads keyed by sessionId ({ tool, type, timestamp }) — drives Recent activity list
  const [notifications, setNotifications] = useState(() => ({}));
  // 4-state map: sessionId → { state, tool, since } (idle/working/blocked/done)
  const [sessionStatus, setSessionStatus] = useState(() => ({}));

  const refresh = () => {
    socket.emit("getSessions", (list) => setSessions(Array.isArray(list) ? list : []));
    socket.emit("getGroups", (list) => setGroups(Array.isArray(list) ? list : []));
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const onConnect = () => { setConnected(true); refreshRef.current(); };
    const onDisconnect = () => setConnected(false);
    // Server emits "terminal:ready" AFTER getSessions/getGroups handlers are registered.
    // F5 raced the initial fetch ahead of async setup → empty list. This is the gate.
    const onReady = () => { refreshRef.current(); socket.emit("getNotificationState"); socket.emit("getStatusState"); };
    const onChanged = () => refreshRef.current();
    // Terminal command finished (AI hook) → mark session badge
    const onFinish = (n) => {
      if (!n?.sessionId) return;
      setFinishedIds((p) => new Set(p).add(n.sessionId));
      setNotifications((p) => ({ ...p, [n.sessionId]: n }));
      // Local OS banner only when the window is backgrounded — mirrors the
      // server-side hidden check for push. Skipped outside the Tauri shell.
      if (typeof document !== "undefined" && document.hidden) {
        const label = AGENT_LABELS[n.tool] || "AI";
        const done = n.type === "stop" || n.state === "done";
        showTauriNotification({
          title: done ? `${label} ✅` : `${label} 🔔`,
          body: done ? `${label} completed the task` : `${label} needs your input`,
        });
      }
    };
    // Restore badge state from agent on connect/reload. Merge into Recent (history), never drop existing entries.
    const onState = (state) => { const s = state || {}; setFinishedIds(new Set(Object.keys(s))); setNotifications((p) => ({ ...p, ...s })); };
    // Another client cleared a badge → mirror badge only, keep it in Recent
    const onCleared = (sessionId) => setFinishedIds((p) => { if (!p.has(sessionId)) return p; const n = new Set(p); n.delete(sessionId); return n; });

    // 4-state (idle/working/blocked/done) handlers
    const onStatusState = (state) => setSessionStatus(state || {});
    const onStatusChange = ({ sessionId, state, tool, since }) => { if (!sessionId) return; setSessionStatus((p) => ({ ...p, [sessionId]: { state, tool, since } })); };
    const onStatusCleared = (sessionId) => setSessionStatus((p) => { if (!p[sessionId]) return p; const { [sessionId]: _, ...rest } = p; return rest; });

    socket.on("connect", onConnect);
    socket.on("terminal:ready", onReady);
    socket.on("disconnect", onDisconnect);
    socket.on("sessionClosed", onChanged);
    socket.on("groupsChanged", onChanged);
    socket.on("session-renamed", onChanged);
    socket.on("chatNotification", onFinish);
    socket.on("notificationState", onState);
    socket.on("notificationCleared", onCleared);
    socket.on("statusState", onStatusState);
    socket.on("statusChange", onStatusChange);
    socket.on("statusCleared", onStatusCleared);

    return () => {
      socket.off("connect", onConnect);
      socket.off("terminal:ready", onReady);
      socket.off("disconnect", onDisconnect);
      socket.off("sessionClosed", onChanged);
      socket.off("groupsChanged", onChanged);
      socket.off("session-renamed", onChanged);
      socket.off("chatNotification", onFinish);
      socket.off("notificationState", onState);
      socket.off("notificationCleared", onCleared);
      socket.off("statusState", onStatusState);
      socket.off("statusChange", onStatusChange);
      socket.off("statusCleared", onStatusCleared);
    };
  }, []);

  // Sync dock/taskbar badge to unread count. No-op outside the Tauri shell.
  useEffect(() => { setTauriBadge(finishedIds.size); }, [finishedIds]);

  // Clear local badge + notify agent (keeps server state accurate)
  const clearFinished = (sessionId) => {
    setFinishedIds((p) => { if (!p.has(sessionId)) return p; const n = new Set(p); n.delete(sessionId); return n; });
    // Only drop status if DONE (seen → idle). working/blocked persist across focus.
    setSessionStatus((p) => { if (!p[sessionId] || p[sessionId].state !== "done") return p; const { [sessionId]: _, ...rest } = p; return rest; });
    socket.emit("clearNotification", sessionId);
    socket.emit("clearStatus", sessionId);
  };

  // Remove a Recent activity entry (manual dismiss, local only)
  const dismissRecent = (sessionId) => setNotifications((p) => { if (!p[sessionId]) return p; const n = { ...p }; delete n[sessionId]; return n; });

  const createSession = (groupId, cb, name) => socket.emit("createSession", { groupId: groupId || null, name: name || null }, (r) => { refresh(); cb?.(r); });
  const deleteSession = (sessionId) => socket.emit("deleteSession", sessionId, () => refresh());
  const renameSession = (sessionId, name) => socket.emit("renameSession", { sessionId, name }, () => refresh());
  const createGroup = (name, cb) => socket.emit("createGroup", { name }, (r) => { refresh(); cb?.(r); });
  const renameGroup = (groupId, name) => socket.emit("renameGroup", { groupId, name }, () => refresh());
  const deleteGroup = (groupId) => socket.emit("deleteGroup", { groupId }, () => refresh());

  // Update a session's cwd locally (OSC 7 client-side parse) — no server round-trip
  const updateCwd = (sessionId, cwd) => {
    if (!sessionId || !cwd) return;
    setSessions((prev) => prev.map((s) => (s.id === sessionId && s.cwd !== cwd ? { ...s, cwd } : s)));
  };

  return { socket, connected, sessions, groups, finishedIds, sessionStatus, notifications, clearFinished, dismissRecent, refresh, createSession, deleteSession, renameSession, createGroup, renameGroup, deleteGroup, updateCwd };
}

export { getSocket };
