import { useEffect, useState, useCallback, useRef } from "react";
import { useBaseSocket } from "@/shared/hooks/useBaseSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { commitPendingKey, forgetRejectedTail } from "@/shared/transport/lib/deviceTrust";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { WORKER_API } from "@/shared/constants/API";
import { TAIL_REJECT_REASON, LOGIN_ERROR_KEY, APPROVAL_STATUS } from "@/shared/constants/transport";

// Resume on mobile triggers several list-refresh paths within a few ms; this
// window collapses them into one round-trip.
const FETCH_COALESCE_MS = 120;

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
  const [approvalStatus, setApprovalStatus] = useState(null); // null | APPROVAL_STATUS
  // A carrier being open is not the same as the agent having let us in: the
  // TAIL is proven after the socket connects, so there is a window where we are
  // "connected" but not admitted. Sticky for the page's lifetime — a later
  // carrier flap must not re-gate a session the agent already accepted.
  const [admitted, setAdmitted] = useState(false);
  const { getAuth } = useSessionStorage();

  // Approval arrives on TWO independent carriers — socket.io device:* events
  // and the DO signaling relay (which answers before any socket exists). Both
  // funnel through here so the verdict follows one set of rules instead of
  // whichever path happened to fire last.
  //   pending/rejected  = a policy answer from the host; only the host changes it
  //   approved          = terminal for this session
  //   carrier-reconnect = NOT an answer, must never clear a standing verdict
  const applyApproval = useCallback((next) => {
    setApprovalStatus((prev) => {
      if (next === APPROVAL_STATUS.reconnect) return prev === APPROVAL_STATUS.approved ? null : prev;
      if (prev === APPROVAL_STATUS.approved && next === APPROVAL_STATUS.pending) return prev; // stale late signal
      return next;
    });
  }, []);

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

  // A non-array ack is a carrier failure, not an answer: PM rejects every pending ack
  // with { error: "rtc-closed" } when RTC dies. Marking it loaded would stop the retry
  // below forever and leave the lists empty until a full reload.
  const applySessions = useCallback((list) => {
    if (!Array.isArray(list)) return;
    loadedRef.current.sessions = true;
    setSessions(list);
  }, []);

  const applyWorkspaces = useCallback((list) => {
    if (!Array.isArray(list)) return;
    loadedRef.current.workspaces = true;
    setWorkspaces(list);
  }, []);

  // Four independent sources ask for these lists (terminal:ready, the socket
  // "connect" rejoin, the visibility refetch, and the 2s retry) — a single
  // resume used to fire up to 8 emits at once, and their acks can land out of
  // order, letting an older snapshot overwrite a newer one. Collapse the burst
  // and stamp each request so only the newest answer is applied.
  // One counter PER LIST: a shared one made the two requests cancel each other
  // (getSessions bumped the seq the getWorkspaces ack was waiting on, so the
  // workspace list never applied).
  const sessionSeqRef = useRef(0);
  const workspaceSeqRef = useRef(0);
  const fetchTimerRef = useRef(null);

  const emitSessions = useCallback((socket) => {
    const seq = ++sessionSeqRef.current;
    socket.emit("getSessions", (list) => { if (seq === sessionSeqRef.current) applySessions(list); });
  }, [applySessions]);

  const emitWorkspaces = useCallback((socket) => {
    const seq = ++workspaceSeqRef.current;
    socket.emit("getWorkspaces", (list) => { if (seq === workspaceSeqRef.current) applyWorkspaces(list); });
  }, [applyWorkspaces]);

  const fetchLists = useCallback((socket) => {
    if (!socket) return;
    if (fetchTimerRef.current) return; // burst already pending
    fetchTimerRef.current = setTimeout(() => {
      fetchTimerRef.current = null;
      emitWorkspaces(socket);
      emitSessions(socket);
    }, FETCH_COALESCE_MS);
  }, [emitSessions, emitWorkspaces]);

  // The proxy socket this hook's listeners are bound to. onConnect fires again on
  // every carrier reconnect after a full outage, but the proxy — and the listeners
  // tracked on it — survive, so re-binding would stack a fresh closure set per outage.
  const boundSocketRef = useRef(null);

  const handleSocketReady = useCallback((socket, auth) => {
    // A carrier coming up is not a verdict — see applyApproval.
    applyApproval(APPROVAL_STATUS.reconnect);
    // A reconnect may have missed create/delete done elsewhere while we were away,
    // so neither list is trustworthy until the agent answers again.
    loadedRef.current = { sessions: false, workspaces: false };

    if (boundSocketRef.current === socket) {
      fetchLists(socket);
      return;
    }
    boundSocketRef.current = socket;

    // Listen for device approval flow
    socket.on("device:pendingApproval", () => {
      console.log("[auth] agent says: waiting for host approval"); // TEMP DIAGNOSTIC
      applyApproval(APPROVAL_STATUS.pending);
    });

    socket.on("device:approved", () => {
      applyApproval(APPROVAL_STATUS.approved);
      setAdmitted(true);
      // The agent accepted this key — the first moment anything checked the
      // TAIL, and so the first moment it is worth remembering.
      commitPendingKey();
      removeTempKey();
    });

    // Server emits "terminal:ready" AFTER getSessions/getWorkspaces handlers are registered
    // (async setupSocketFeatures). Fetching here avoids the F5 race that returned empty.
    // NOT an admission signal: the agent wires features while the key TAIL is
    // still inside its proof window, so this fires for a device that may yet be
    // refused. Only device:approved says the agent accepted us.
    socket.on("terminal:ready", () => {
      console.log("[auth] terminal:ready (NOT an admission signal)"); // TEMP DIAGNOSTIC
      fetchLists(socket);
    });

    // Carrier rejoin (resume from background, RTC<->WS switch). The agent keeps the
    // same session, so it may not re-emit "terminal:ready" — refetch here or the
    // lists keep showing what was true before the device went to sleep.
    // clientReady re-asserts per connection: onConnect above fires once per PM
    // lifetime, but the agent defers per-socket device:* answers on this event —
    // a reconnect that skips it (e.g. zombie RTC kept "connected") would never
    // get its pending/approved notification.
    socket.on("connect", () => {
      loadedRef.current = { sessions: false, workspaces: false };
      socket.emit("device:clientReady");
      fetchLists(socket);
    });

    socket.on("device:rejected", () => {
      applyApproval(APPROVAL_STATUS.rejected);
      // Stop auto-reconnect — user must re-submit key to try again
      disconnectRef.current?.();
    });

    socket.on("device:tailRejected", (data) => {
      // seal-unreadable = stale pin (agent rotated its host key): deviceTrust
      // drops the pin and the agent's disconnect triggers a plain-tail retry.
      if (data?.reason === TAIL_REJECT_REASON.sealUnreadable) return;
      // A wrong key is a failed LOGIN, not a device awaiting approval — there is
      // nothing for the host to approve. Drop the session the way logout does
      // (the stored key is the wrong one; keeping it would walk straight back
      // in), then hand the login page a reason to show. Stamped AFTER the
      // clear, which wipes everything in sessionStorage.
      disconnectRef.current?.();
      // Drop the TAIL that failed, under whichever key holds it: a one-time
      // login keeps it under the CODE, an API key login under the key's HEAD.
      // Clearing only the HEAD left a bad code's tail behind, so the next
      // attempt presented the same wrong secret again.
      //
      // The saved-keys list is left alone: this key was never committed there
      // (that only happens on acceptance), and any key that IS there was
      // accepted at some point — a bad attempt must not take it away.
      const auth = getAuth();
      forgetRejectedTail(auth?.apiKey);
      forgetRejectedTail(auth?.tempKey);
      sessionStorage.clear();
      sessionStorage.setItem(LOGIN_ERROR_KEY, data?.reason || TAIL_REJECT_REASON.mismatch);
      window.location.replace("/login");
    });

    socket.on("serverInfo", (info) => {
      setRemoteAvailable(info.remoteAvailable);
      setPlatform(info.platform);
      setAgentVersion(info.version || null);
      setUpdateAvailable(info.updateAvailable || null);
      setCanSelfUpdate(!!info.canSelfUpdate);
      useTerminalStore.getState().setAgentCaps(info.caps || {});
      useTerminalStore.getState().setArtifactEnabled(info.artifactEnabled);
      useTerminalStore.getState().setMcpClients(info.mcpClients);
      if (info.isCodespaces) {
        setCodespaceInfo({ isCodespaces: info.isCodespaces, codespaceName: info.codespaceName });
      }
    });

    socket.on("sessionClosed", (sessionId) => {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      // Drop everything else keyed by this terminal in the same breath: a pane
      // left open on a dead id renders nothing, and a history row still pointing
      // at it would focus a terminal that isn't there.
      useTerminalStore.getState().closeSession(sessionId);
    });

    // The agent renames a terminal on its own once its conversation has a title,
    // so the name can change without this client having asked for it.
    socket.on("session-renamed", ({ sessionId, name } = {}) => {
      if (!sessionId) return;
      setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, name } : s)));
    });

    // Workspaces changed elsewhere — refresh both lists
    socket.on("workspacesChanged", () => fetchLists(socket));

    socket.on("codespace:stopping", handleCodespaceStopping);

    // Signal server that client listeners are ready
    socket.emit("device:clientReady");
  }, [removeTempKey, handleCodespaceStopping, fetchLists, applyApproval, getAuth]);

  const { socket, socketRef, protocolRef, connected, connectionMode, transport, retryStatus, disconnect } = useBaseSocket({
    namespace: "",
    redirectOnNoAuth: "/",
    onConnect: handleSocketReady,
    onDisconnect: handleDisconnect,
    // Agent refused over signaling — same funnel as the socket.io device:* events
    onApproval: applyApproval
  });

  // Keep ref in sync so event handlers registered above can call disconnect
  disconnectRef.current = disconnect;

  // Load sessions list
  const loadSessions = useCallback(() => {
    if (socketRef.current) emitSessions(socketRef.current);
  }, [socketRef, emitSessions]);

  // Load workspaces list
  const loadWorkspaces = useCallback(() => {
    if (socketRef.current) emitWorkspaces(socketRef.current);
  }, [socketRef, emitWorkspaces]);

  // Pending coalesce timer must not outlive the hook — it captures the socket
  // and would fire after unmount.
  useEffect(() => () => {
    if (fetchTimerRef.current) { clearTimeout(fetchTimerRef.current); fetchTimerRef.current = null; }
  }, []);

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

  // Coming back from background. Carrier events can't be relied on here: if WS stayed
  // up while only RTC died and recovered, the agent keeps the same session (no
  // "terminal:ready") and PM skips the rejoin because the other carrier is ready — so
  // nothing else would refetch, and the lists would still show pre-sleep state.
  // Gated on `connected`: with no carrier ready PM buffers control sends in an
  // unbounded array, and a phone toggled on/off while offline would pile them up.
  // Re-running on `connected` also covers becoming visible while still offline.
  useEffect(() => {
    if (!connected) return;
    const refetch = () => {
      if (document.visibilityState !== "visible") return;
      loadSessions();
      loadWorkspaces();
    };
    refetch();
    document.addEventListener("visibilitychange", refetch);
    return () => document.removeEventListener("visibilitychange", refetch);
  }, [connected, loadSessions, loadWorkspaces]);

  // Create new session (workspaceId optional). cwd = a folder picked in the tree, else
  // inherited from the last session in the workspace.
  // `nameIsAuto` marks a name the UI filled in rather than the user typing it —
  // the agent keeps renaming such a terminal after the conversation it runs.
  const createSession = useCallback((name, shellId, workspaceId, cwd, callback, nameIsAuto = false) => {
    if (!socketRef.current) return;
    // Backward compat: createSession(name, callback) / createSession(name, shellId, callback)
    if (typeof shellId === "function") { callback = shellId; shellId = null; workspaceId = null; cwd = null; }
    else if (typeof workspaceId === "function") { callback = workspaceId; workspaceId = null; cwd = null; }
    else if (typeof cwd === "function") { callback = cwd; cwd = null; }

    socketRef.current.emit("createSession", { name, shellId, workspaceId, cwd, nameIsAuto }, (result) => {
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
    admitted,
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
