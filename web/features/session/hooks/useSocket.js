import { useEffect, useState, useCallback } from "react";
import { useBaseSocket } from "@/shared/hooks/useBaseSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { WORKER_API } from "@/shared/constants/API";

// Socket.io connection management hook for Terminal
export function useSocket() {
  const [sessions, setSessions] = useState([]);
  const [remoteAvailable, setRemoteAvailable] = useState(false);
  const [codespaceInfo, setCodespaceInfo] = useState(null);
  const [codespaceDisconnected, setCodespaceDisconnected] = useState(false);
  const [platform, setPlatform] = useState(null);
  const [approvalStatus, setApprovalStatus] = useState(null); // null | "pending" | "approved" | "rejected"
  const { getAuth } = useSessionStorage();

  // Remove one-time key from worker after device is approved
  const removeTempKey = useCallback(async () => {
    const auth = getAuth();
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
  }, [getAuth]);

  // Handle disconnect - mark codespace as disconnected
  const handleDisconnect = useCallback((reason) => {
    if (codespaceInfo?.isCodespaces) {
      setCodespaceDisconnected(true);
    }
  }, [codespaceInfo]);

  // Handle codespace stopping event - server is about to shut down
  const [codespaceStopping, setCodespaceStopping] = useState(false);
  const handleCodespaceStopping = useCallback(() => {
    setCodespaceStopping(true);
  }, []);

  const handleSocketReady = useCallback((socket, auth) => {
    // Reset approval status on new connection
    setApprovalStatus(null);

    // Listen for device approval flow
    socket.on("device:pendingApproval", () => {
      setApprovalStatus("pending");
    });

    socket.on("device:approved", () => {
      setApprovalStatus("approved");
      removeTempKey();
    });

    socket.on("device:rejected", () => {
      setApprovalStatus("rejected");
    });

    socket.on("serverInfo", (info) => {
      setRemoteAvailable(info.remoteAvailable);
      setPlatform(info.platform);
      if (info.isCodespaces) {
        setCodespaceInfo({ isCodespaces: info.isCodespaces, codespaceName: info.codespaceName });
      }
    });

    socket.on("sessionClosed", (sessionId) => {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    });

    socket.on("codespace:stopping", handleCodespaceStopping);

    // Signal server that client listeners are ready
    socket.emit("device:clientReady");
  }, [removeTempKey, handleCodespaceStopping]);

  const { socket, socketRef, connected, connectionMode, retryStatus } = useBaseSocket({
    namespace: "",
    redirectOnNoAuth: "/",
    onConnect: handleSocketReady,
    onDisconnect: handleDisconnect
  });

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
    socketRef,
    connected,
    connectionMode,
    retryStatus,
    approvalStatus,
    sessions,
    remoteAvailable,
    codespaceInfo,
    codespaceDisconnected,
    codespaceStopping,
    platform,
    loadSessions,
    createSession,
    deleteSession,
    renameSession,
    stopCodespace
  };
}
