import { useEffect, useState, useCallback } from "react";
import { useBaseSocket } from "@/shared/hooks/useBaseSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { WORKER_API } from "@/shared/constants/api";

// Socket.io connection management hook for Terminal
export function useSocket() {
  const [sessions, setSessions] = useState([]);
  const [remoteAvailable, setRemoteAvailable] = useState(false);
  const [codespaceInfo, setCodespaceInfo] = useState(null);
  const [codespaceDisconnected, setCodespaceDisconnected] = useState(false);
  const { getAuth } = useSessionStorage();

  // Handle connect - remove temp key if exists
  const handleConnect = useCallback(async (socket, auth) => {
    if (auth?.tempKey) {
      try {
        await fetch(`${WORKER_API}/api/temp-key/remove`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tempKey: auth.tempKey })
        });
        sessionStorage.removeItem("tempKey");
      } catch (error) {
        console.error("Failed to remove temp key:", error);
      }
    }
  }, []);

  // Handle disconnect - mark codespace as disconnected
  const handleDisconnect = useCallback((reason) => {
    if (codespaceInfo?.isCodespaces) {
      setCodespaceDisconnected(true);
    }
  }, [codespaceInfo]);

  const { socket, socketRef, connected, error, retryStatus } = useBaseSocket({
    namespace: "",
    redirectOnNoAuth: "/",
    onConnect: handleConnect,
    onDisconnect: handleDisconnect
  });

  // Setup terminal-specific event listeners
  useEffect(() => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return;

    const handleServerInfo = (info) => {
      setRemoteAvailable(info.remoteAvailable);
      if (info.isCodespaces) {
        setCodespaceInfo({
          isCodespaces: info.isCodespaces,
          codespaceName: info.codespaceName
        });
      }
    };

    const handleSessionClosed = (sessionId) => {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    };

    currentSocket.on("serverInfo", handleServerInfo);
    currentSocket.on("sessionClosed", handleSessionClosed);

    return () => {
      currentSocket.off("serverInfo", handleServerInfo);
      currentSocket.off("sessionClosed", handleSessionClosed);
    };
  }, [socketRef, connected]);

  // Load sessions list
  const loadSessions = useCallback(() => {
    if (!socketRef.current) return;
    
    socketRef.current.emit("getSessions", (list) => {
      setSessions(list);
    });
  }, [socketRef]);

  // Create new session
  const createSession = useCallback((name, callback) => {
    if (!socketRef.current) return;

    socketRef.current.emit("createSession", { name }, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [socketRef, loadSessions]);

  // Delete session
  const deleteSession = useCallback((sessionId, callback) => {
    if (!socketRef.current) return;

    socketRef.current.emit("deleteSession", sessionId, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [socketRef, loadSessions]);

  // Rename session
  const renameSession = useCallback((sessionId, newName, callback) => {
    if (!socketRef.current) return;

    socketRef.current.emit("renameSession", { sessionId, name: newName }, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [socketRef, loadSessions]);

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
    socket,
    connected,
    error,
    retryStatus,
    sessions,
    remoteAvailable,
    codespaceInfo,
    codespaceDisconnected,
    loadSessions,
    createSession,
    deleteSession,
    renameSession,
    stopCodespace
  };
}
