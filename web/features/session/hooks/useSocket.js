import { useEffect, useState, useCallback, useRef } from "react";
import { useBaseSocket } from "@/shared/hooks/useBaseSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { WORKER_API } from "@/shared/constants/API";

// Socket.io connection management hook for Terminal
export function useSocket() {
  const [sessions, setSessions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [remoteAvailable, setRemoteAvailable] = useState(false);
  const [codespaceInfo, setCodespaceInfo] = useState(null);
  const [codespaceDisconnected, setCodespaceDisconnected] = useState(false);
  const [platform, setPlatform] = useState(null);
  const [agentVersion, setAgentVersion] = useState(null);
  const [updateAvailable, setUpdateAvailable] = useState(null);
  const [canSelfUpdate, setCanSelfUpdate] = useState(false);
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

  // Ref to the disconnect function from useBaseSocket (set below).
  // Needed here because socket.on("device:rejected") must call it, but it's defined after.
  const disconnectRef = useRef(null);

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

    // Server emits "terminal:ready" AFTER getSessions/getGroups handlers are registered
    // (async setupSocketFeatures). Fetching here avoids the F5 race that returned empty.
    socket.on("terminal:ready", () => {
      socket.emit("getGroups", (list) => setGroups(list || []));
      socket.emit("getSessions", (list) => setSessions(list || []));
    });

    socket.on("device:rejected", () => {
      setApprovalStatus("rejected");
      // Stop auto-reconnect — user must re-submit key to try again
      disconnectRef.current?.();
    });

    socket.on("serverInfo", (info) => {
      setRemoteAvailable(info.remoteAvailable);
      setPlatform(info.platform);
      setAgentVersion(info.version || null);
      setUpdateAvailable(info.updateAvailable || null);
      setCanSelfUpdate(!!info.canSelfUpdate);
      useTerminalStore.getState().setAgentCaps(info.caps || {});
      if (info.isCodespaces) {
        setCodespaceInfo({ isCodespaces: info.isCodespaces, codespaceName: info.codespaceName });
      }
    });

    socket.on("sessionClosed", (sessionId) => {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    });

    // Groups changed elsewhere — refresh both lists
    socket.on("groupsChanged", () => {
      socket.emit("getGroups", (list) => setGroups(list || []));
      socket.emit("getSessions", (list) => setSessions(list || []));
    });

    socket.on("codespace:stopping", handleCodespaceStopping);

    // Signal server that client listeners are ready
    socket.emit("device:clientReady");
  }, [removeTempKey, handleCodespaceStopping]);

  const { socket, socketRef, protocolRef, connected, connectionMode, transport, retryStatus, disconnect } = useBaseSocket({
    namespace: "",
    redirectOnNoAuth: "/",
    onConnect: handleSocketReady,
    onDisconnect: handleDisconnect
  });

  // Keep ref in sync so event handlers registered above can call disconnect
  disconnectRef.current = disconnect;

  // Load sessions list
  const loadSessions = useCallback(() => {
    if (!socketRef.current) return;
    
    socketRef.current.emit("getSessions", (list) => {
      setSessions(list);
    });
  }, [socketRef]);

  // Load groups list
  const loadGroups = useCallback(() => {
    if (!socketRef.current) return;
    socketRef.current.emit("getGroups", (list) => setGroups(list || []));
  }, [socketRef]);

  // Create new session (groupId optional). cwd = inherit from last session in group.
  const createSession = useCallback((name, shellId, groupId, cwd, callback) => {
    if (!socketRef.current) return;
    // Backward compat: createSession(name, callback) / createSession(name, shellId, callback)
    if (typeof shellId === "function") { callback = shellId; shellId = null; groupId = null; cwd = null; }
    else if (typeof groupId === "function") { callback = groupId; groupId = null; cwd = null; }
    else if (typeof cwd === "function") { callback = cwd; cwd = null; }

    socketRef.current.emit("createSession", { name, shellId, groupId, cwd }, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [socketRef, loadSessions]);

  // Group CRUD + move
  const createGroup = useCallback((name, callback) => {
    socketRef.current?.emit("createGroup", { name }, (result) => { if (result?.success) loadGroups(); callback?.(result); });
  }, [socketRef, loadGroups]);

  const renameGroup = useCallback((groupId, name, callback) => {
    socketRef.current?.emit("renameGroup", { groupId, name }, (result) => { if (result?.success) loadGroups(); callback?.(result); });
  }, [socketRef, loadGroups]);

  const deleteGroup = useCallback((groupId, callback) => {
    socketRef.current?.emit("deleteGroup", { groupId }, (result) => { if (result?.success) { loadGroups(); loadSessions(); } callback?.(result); });
  }, [socketRef, loadGroups, loadSessions]);

  const moveSession = useCallback((sessionId, groupId, callback) => {
    socketRef.current?.emit("moveSession", { sessionId, groupId }, (result) => { if (result?.success) loadSessions(); callback?.(result); });
  }, [socketRef, loadSessions]);

  // Reorder sessions within a group; orderedIds = desired order of that group's sessions
  const reorderSession = useCallback((orderedIds, callback) => {
    socketRef.current?.emit("reorderSession", { orderedIds }, (result) => { if (result?.success) loadSessions(); callback?.(result); });
  }, [socketRef, loadSessions]);

  // Fetch available shells from agent
  const getShells = useCallback((callback) => {
    if (!socketRef.current) return;
    socketRef.current.emit("getShells", (result) => callback?.(result));
  }, [socketRef]);

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

  // Trigger agent self-update via socket (authenticated, survives tunnel restart)
  const triggerUpdate = useCallback(() => {
    const sock = socketRef.current;
    if (!sock?.connected) return false;
    protocolRef.current?.setUpdating?.(true);
    sock.emit("requestUpdate");
    return true;
  }, [socketRef, protocolRef]);

  // Restart agent host (no reinstall): kill + relaunch, ptyDaemon survives
  const triggerRestart = useCallback(() => {
    const sock = socketRef.current;
    if (!sock?.connected) return false;
    protocolRef.current?.setUpdating?.(true);
    sock.emit("requestRestart");
    return true;
  }, [socketRef, protocolRef]);

  return {
    socket,
    socketRef,
    protocolRef,
    connected,
    connectionMode,
    transport,
    retryStatus,
    approvalStatus,
    sessions,
    remoteAvailable,
    codespaceInfo,
    codespaceDisconnected,
    codespaceStopping,
    platform,
    agentVersion,
    updateAvailable,
    canSelfUpdate,
    triggerUpdate,
    triggerRestart,
    groups,
    loadSessions,
    loadGroups,
    createSession,
    getShells,
    deleteSession,
    renameSession,
    createGroup,
    renameGroup,
    deleteGroup,
    moveSession,
    reorderSession,
    stopCodespace
  };
}
