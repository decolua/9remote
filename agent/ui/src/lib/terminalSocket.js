import { useState, useEffect, useRef } from "preact/hooks";
import { io } from "socket.io-client";

// Single same-origin socket for the local UI.
// Trusted via ephemeral local token (mem-only on server) — resists CSWSH.
let socketSingleton = null;
function getSocket() {
  if (!socketSingleton) {
    socketSingleton = io({
      transports: ["websocket"],
      autoConnect: false,
      auth: { deviceId: "local-ui" },
    });
    // Fetch local token (loopback + same-origin guarded), then connect
    fetch("/api/local-token")
      .then((r) => r.json())
      .then((d) => { socketSingleton.auth = { deviceId: "local-ui", localToken: d.localToken }; })
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

  const refresh = () => {
    socket.emit("getSessions", (list) => setSessions(Array.isArray(list) ? list : []));
    socket.emit("getGroups", (list) => setGroups(Array.isArray(list) ? list : []));
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const onConnect = () => { setConnected(true); refreshRef.current(); };
    const onDisconnect = () => setConnected(false);
    const onChanged = () => refreshRef.current();
    // Terminal command finished (AI hook) → mark session badge
    const onFinish = (n) => { if (n?.sessionId) setFinishedIds((p) => new Set(p).add(n.sessionId)); };
    // Restore badge state from agent (source of truth) on connect/reload
    const onState = (state) => setFinishedIds(new Set(Object.keys(state || {})));
    // Another client cleared a badge → mirror locally
    const onCleared = (sessionId) => setFinishedIds((p) => { if (!p.has(sessionId)) return p; const n = new Set(p); n.delete(sessionId); return n; });
    const syncState = () => { onConnect(); socket.emit("getNotificationState"); };

    socket.on("connect", syncState);
    socket.on("disconnect", onDisconnect);
    socket.on("sessionClosed", onChanged);
    socket.on("groupsChanged", onChanged);
    socket.on("session-renamed", onChanged);
    socket.on("chatNotification", onFinish);
    socket.on("notificationState", onState);
    socket.on("notificationCleared", onCleared);

    if (socket.connected) syncState();

    return () => {
      socket.off("connect", syncState);
      socket.off("disconnect", onDisconnect);
      socket.off("sessionClosed", onChanged);
      socket.off("groupsChanged", onChanged);
      socket.off("session-renamed", onChanged);
      socket.off("chatNotification", onFinish);
      socket.off("notificationState", onState);
      socket.off("notificationCleared", onCleared);
    };
  }, []);

  // Clear local badge + notify agent (keeps server state accurate)
  const clearFinished = (sessionId) => {
    setFinishedIds((p) => { if (!p.has(sessionId)) return p; const n = new Set(p); n.delete(sessionId); return n; });
    socket.emit("clearNotification", sessionId);
  };

  const createSession = (groupId, cb, name) => socket.emit("createSession", { groupId: groupId || null, name: name || null }, (r) => { refresh(); cb?.(r); });
  const deleteSession = (sessionId) => socket.emit("deleteSession", sessionId, () => refresh());
  const renameSession = (sessionId, name) => socket.emit("renameSession", { sessionId, name }, () => refresh());
  const createGroup = (name, cb) => socket.emit("createGroup", { name }, (r) => { refresh(); cb?.(r); });
  const renameGroup = (groupId, name) => socket.emit("renameGroup", { groupId, name }, () => refresh());
  const deleteGroup = (groupId) => socket.emit("deleteGroup", { groupId }, () => refresh());

  return { socket, connected, sessions, groups, finishedIds, clearFinished, refresh, createSession, deleteSession, renameSession, createGroup, renameGroup, deleteGroup };
}

export { getSocket };
