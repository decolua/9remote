import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";

// Socket.io connection management hook
export function useSocket() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [remoteAvailable, setRemoteAvailable] = useState(false);
  const [codespaceInfo, setCodespaceInfo] = useState(null);
  const socketRef = useRef(null);
  const router = useRouter();
  const { getAuth } = useSessionStorage();

  // Initialize socket connection
  useEffect(() => {
    const auth = getAuth();
    
    if (!auth?.tunnelUrl) {
      router.push("/");
      return;
    }

    const newSocket = io(auth.tunnelUrl, {
      path: "/socket.io",
      transports: ["polling", "websocket"]
    });

    newSocket.on("connect", () => {
      setConnected(true);
    });

    newSocket.on("disconnect", () => {
      setConnected(false);
    });

    newSocket.on("serverInfo", (info) => {
      setRemoteAvailable(info.remoteAvailable);
      if (info.isCodespaces) {
        setCodespaceInfo({
          isCodespaces: info.isCodespaces,
          codespaceName: info.codespaceName
        });
      }
    });

    newSocket.on("sessionClosed", (sessionId) => {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load sessions list
  const loadSessions = useCallback(() => {
    if (!socketRef.current) return;
    
    socketRef.current.emit("getSessions", (list) => {
      setSessions(list);
    });
  }, []);

  // Create new session
  const createSession = useCallback((name, callback) => {
    if (!socketRef.current) return;

    socketRef.current.emit("createSession", { name }, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [loadSessions]);

  // Delete session
  const deleteSession = useCallback((sessionId, callback) => {
    if (!socketRef.current) return;

    socketRef.current.emit("deleteSession", sessionId, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [loadSessions]);

  // Rename session
  const renameSession = useCallback((sessionId, newName, callback) => {
    if (!socketRef.current) return;

    socketRef.current.emit("renameSession", { sessionId, name: newName }, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [loadSessions]);

  // Stop codespace
  const stopCodespace = useCallback(async () => {
    const auth = getAuth();
    if (!auth?.tunnelUrl || !codespaceInfo?.isCodespaces) return false;
    
    try {
      const response = await fetch(`${auth.tunnelUrl}/api/codespace/stop`, {
        method: "POST"
      });
      return response.ok;
    } catch {
      return false;
    }
  }, [getAuth, codespaceInfo]);

  return {
    socket: socketRef.current,
    connected,
    sessions,
    remoteAvailable,
    codespaceInfo,
    loadSessions,
    createSession,
    deleteSession,
    renameSession,
    stopCodespace
  };
}
