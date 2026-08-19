import { useEffect, useState, useCallback, useRef } from "react";
import { useBaseSocket } from "@/shared/hooks/useBaseSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { WORKER_API } from "@/shared/constants/API";

// Socket.io connection management hook for Terminal
export function useSocket() {
  const [sessions, setSessions] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
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

  // Whether each list has ever received a response — gates the retry below.
  // An empty [] response counts; only lost packets keep retrying.
  const loadedRef = useRef({ sessions: false, workspaces: false });

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

    // Server emits "terminal:ready" AFTER getSessions/getWorkspaces handlers are registered
    // (async setupSocketFeatures). Fetching here avoids the F5 race that returned empty.
    socket.on("terminal:ready", () => {
      socket.emit("getWorkspaces", (list) => {
        loadedRef.current.workspaces = true;
        setWorkspaces(Array.isArray(list) ? list : []);
      });
      socket.emit("getSessions", (list) => {
        loadedRef.current.sessions = true;
        setSessions(Array.isArray(list) ? list : []);
      });
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

    // Workspaces changed elsewhere — refresh both lists
    socket.on("workspacesChanged", () => {
      socket.emit("getWorkspaces", (list) => {
        loadedRef.current.workspaces = true;
        setWorkspaces(Array.isArray(list) ? list : []);
      });
      socket.emit("getSessions", (list) => {
        loadedRef.current.sessions = true;
        setSessions(Array.isArray(list) ? list : []);
      });
    });

    socket.on("codespace:stopping", handleCodespaceStopping);

    // Signal server that client listeners are ready
    socket.emit("device:clientReady");
  }, [removeTempKey, handleCodespaceStopping]);

  const { socket, socketRef, protocolRef, connected, connectionMode, transport, retryStatus, disconnect } = useBaseSocket({
    namespace: "",
    redirectOnNoAuth: "/",
    onConnect: handleSocketReady,
    onDisconnect: handleDisconnect,
    // Agent refused over signaling — same modal as the socket.io device:* events
    onApproval: setApprovalStatus
  });

  // Keep ref in sync so event handlers registered above can call disconnect
  disconnectRef.current = disconnect;

  // Load sessions list
  const loadSessions = useCallback(() => {
    if (!socketRef.current) return;

    socketRef.current.emit("getSessions", (list) => {
      loadedRef.current.sessions = true;
      setSessions(Array.isArray(list) ? list : []);
    });
  }, [socketRef]);

  // Load workspaces list
  const loadWorkspaces = useCallback(() => {
    if (!socketRef.current) return;
    socketRef.current.emit("getWorkspaces", (list) => {
      loadedRef.current.workspaces = true;
      setWorkspaces(Array.isArray(list) ? list : []);
    });
  }, [socketRef]);

  // terminal:ready is one-shot over a racy multi-carrier transport — if it or a fetch
  // ack is dropped, the lists stay empty forever. Retry while connected until each
  // list has ever received a response; receiving [] also counts (stops forever then).
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      if (loadedRef.current.sessions && loadedRef.current.workspaces) return;
      loadSessions();
      loadWorkspaces();
    }, 2000);
    return () => clearInterval(timer);
  }, [connected, loadSessions, loadWorkspaces]);

  // Create new session (workspaceId optional). cwd = a folder picked in the tree, else
  // inherited from the last session in the workspace.
  const createSession = useCallback((name, shellId, workspaceId, cwd, callback) => {
    if (!socketRef.current) return;
    // Backward compat: createSession(name, callback) / createSession(name, shellId, callback)
    if (typeof shellId === "function") { callback = shellId; shellId = null; workspaceId = null; cwd = null; }
    else if (typeof workspaceId === "function") { callback = workspaceId; workspaceId = null; cwd = null; }
    else if (typeof cwd === "function") { callback = cwd; cwd = null; }

    socketRef.current.emit("createSession", { name, shellId, workspaceId, cwd }, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [socketRef, loadSessions]);

  // Workspace CRUD + move
  const createWorkspace = useCallback((name, wsPath, callback) => {
    if (typeof wsPath === "function") { callback = wsPath; wsPath = null; }
    socketRef.current?.emit("createWorkspace", { name, path: wsPath }, (result) => { if (result?.success) loadWorkspaces(); callback?.(result); });
  }, [socketRef, loadWorkspaces]);

  const renameWorkspace = useCallback((workspaceId, name, callback) => {
    socketRef.current?.emit("renameWorkspace", { workspaceId, name }, (result) => { if (result?.success) loadWorkspaces(); callback?.(result); });
  }, [socketRef, loadWorkspaces]);

  const deleteWorkspace = useCallback((workspaceId, callback) => {
    socketRef.current?.emit("deleteWorkspace", { workspaceId }, (result) => { if (result?.success) { loadWorkspaces(); loadSessions(); } callback?.(result); });
  }, [socketRef, loadWorkspaces, loadSessions]);

  const setWorkspaceHiddenRepos = useCallback((workspaceId, paths, callback) => {
    socketRef.current?.emit("setWorkspaceHiddenRepos", { workspaceId, paths }, (result) => { if (result?.success) loadWorkspaces(); callback?.(result); });
  }, [socketRef, loadWorkspaces]);

  const moveSession = useCallback((sessionId, workspaceId, callback) => {
    socketRef.current?.emit("moveSession", { sessionId, workspaceId }, (result) => { if (result?.success) loadSessions(); callback?.(result); });
  }, [socketRef, loadSessions]);

  // Reorder sessions within a workspace; orderedIds = desired order of its sessions
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
    workspaces,
    loadSessions,
    loadWorkspaces,
    createSession,
    getShells,
    deleteSession,
    renameSession,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setWorkspaceHiddenRepos,
    moveSession,
    reorderSession,
    stopCodespace
  };
}
