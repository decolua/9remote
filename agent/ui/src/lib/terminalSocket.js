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

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("sessionClosed", onChanged);
    socket.on("groupsChanged", onChanged);
    socket.on("session-renamed", onChanged);

    if (socket.connected) refreshRef.current();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("sessionClosed", onChanged);
      socket.off("groupsChanged", onChanged);
      socket.off("session-renamed", onChanged);
    };
  }, []);

  const createSession = (groupId, cb, name) => socket.emit("createSession", { groupId: groupId || null, name: name || null }, (r) => { refresh(); cb?.(r); });
  const deleteSession = (sessionId) => socket.emit("deleteSession", sessionId, () => refresh());
  const renameSession = (sessionId, name) => socket.emit("renameSession", { sessionId, name }, () => refresh());
  const createGroup = (name, cb) => socket.emit("createGroup", { name }, (r) => { refresh(); cb?.(r); });
  const renameGroup = (groupId, name) => socket.emit("renameGroup", { groupId, name }, () => refresh());
  const deleteGroup = (groupId) => socket.emit("deleteGroup", { groupId }, () => refresh());

  return { socket, connected, sessions, groups, refresh, createSession, deleteSession, renameSession, createGroup, renameGroup, deleteGroup };
}

export { getSocket };
