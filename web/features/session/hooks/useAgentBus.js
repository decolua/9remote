import { useEffect, useState, useCallback, useRef } from "react";
import { useBus } from "@/shared/hooks/useBus";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { commitPendingKey, forgetRejectedTail } from "@/shared/transport/lib/deviceTrust";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useVoiceStore } from "@/shared/stores/voiceStore";
import { WORKER_API } from "@/shared/constants/API";
import { TAIL_REJECT_REASON, LOGIN_ERROR_KEY, APPROVAL_STATUS } from "@/shared/constants/transport";
import { sameList } from "@/shared/utils/shallowEqual";
import { termLog } from "@/shared/utils/termLog";
import { debugLog } from "@/shared/utils/debugLog";

// Mobile resume collapses multiple list-refresh triggers into one round-trip.
const FETCH_COALESCE_MS = 120;
// Drop duplicate list fetches across carriers (RTC then WS) within freshness window.
const FETCH_FRESH_MS = 1000;

export function useAgentBus() {
  const [sessions, setSessions] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [remoteAvailable, setRemoteAvailable] = useState(false);
  const [mobileAvailable, setMobileAvailable] = useState(false);
  const [codespaceInfo, setCodespaceInfo] = useState(null);
  const [codespaceDisconnected, setCodespaceDisconnected] = useState(false);
  const [platform, setPlatform] = useState(null);
  const [agentVersion, setAgentVersion] = useState(null);
  const [updateAvailable, setUpdateAvailable] = useState(null);
  const [canSelfUpdate, setCanSelfUpdate] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState(null); // null | APPROVAL_STATUS
  // Sticky admission flag: carrier connection precedes TAIL proof.
  const [admitted, setAdmitted] = useState(false);
  const { getAuth } = useSessionStorage();

  // Unified handler for device approval arriving from either socket.io or DO signaling relay.
  const applyApproval = useCallback((next) => {
    setApprovalStatus((prev) => {
      // Updater stays pure — the arrival log lives outside (StrictMode double-invokes updaters).
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

  const handleDisconnect = useCallback((reason) => {
    if (codespaceInfo?.isCodespaces) {
      setCodespaceDisconnected(true);
    }
  }, [codespaceInfo]);

  const [codespaceStopping, setCodespaceStopping] = useState(false);
  const handleCodespaceStopping = useCallback(() => {
    setCodespaceStopping(true);
  }, []);

  // Ref to disconnect function from useBus needed before its definition.
  const disconnectRef = useRef(null);

  // Track whether lists have loaded (empty array counts as loaded).
  const loadedRef = useRef({ sessions: false, workspaces: false });
  const bothLoaded = () => loadedRef.current.sessions && loadedRef.current.workspaces;

  const markLoaded = (key) => { loadedRef.current[key] = true; };

  const resetLoaded = useCallback((why) => {
    termLog("switch", `lists untrusted (${why}) → refetch`);
    loadedRef.current = { sessions: false, workspaces: false };
  }, []);

  // Reject non-array ack (carrier failure) to allow retry loop to continue.
  const applySessions = useCallback((list) => {
    if (!Array.isArray(list)) return;
    markLoaded("sessions");
    for (const s of list) {
      if (s?.id && s?.agent) {
        useTerminalStore.getState().setSessionAgent(s.id, s.agent);
      }
    }
    // Keep previous array reference if unchanged to avoid unnecessary re-renders.
    setSessions((prev) => (sameList(prev, list) ? prev : list));
  }, []);

  const applyWorkspaces = useCallback((list) => {
    if (!Array.isArray(list)) return;
    markLoaded("workspaces");
    setWorkspaces((prev) => (sameList(prev, list) ? prev : list));
  }, []);

  // Sequence counters per list to discard out-of-order responses from multiple triggers.
  const sessionSeqRef = useRef(0);
  const workspaceSeqRef = useRef(0);
  const fetchTimerRef = useRef(null);
  const lastFetchAtRef = useRef(0);

  const emitSessions = useCallback((bus) => {
    const seq = ++sessionSeqRef.current;
    bus.emit("getSessions", (list) => {
      termLog("diag", `getSessions ack seq=${seq} type=${Array.isArray(list) ? "list" : typeof list} n=${Array.isArray(list) ? list.length : "-"}`);
      if (seq === sessionSeqRef.current) applySessions(list);
    });
  }, [applySessions]);

  const emitWorkspaces = useCallback((bus) => {
    const seq = ++workspaceSeqRef.current;
    bus.emit("getWorkspaces", (list) => { if (seq === workspaceSeqRef.current) applyWorkspaces(list); });
  }, [applyWorkspaces]);

  // Coalesce list fetch triggers into a single round-trip.
  const fetchLists = useCallback((bus, force = false) => {
    if (!bus) return;
    if (force) clearTimeout(fetchTimerRef.current);
    else if (fetchTimerRef.current) return;
    else if (bothLoaded() && Date.now() - lastFetchAtRef.current < FETCH_FRESH_MS) return;
    fetchTimerRef.current = setTimeout(() => {
      fetchTimerRef.current = null;
      lastFetchAtRef.current = Date.now();
      termLog("diag", `fetchLists FIRE (bus=${bus ? "ok" : "null"} connected-already=${loadedRef.current.sessions}/${loadedRef.current.workspaces})`);
      emitWorkspaces(bus);
      emitSessions(bus);
    }, FETCH_COALESCE_MS);
  }, [emitSessions, emitWorkspaces]);

  // Client capability announcement required by agent for binary/fragmented transport.
  const CAPS = { fragOut: true, binOut: true, hb: 1, env2: 1, fragCtl: 1 };
  const announceCaps = (bus) => {
    termLog("switch", `caps → ${JSON.stringify(CAPS)} announced`);
    bus.emit("caps", CAPS);
  };

  // Track bound bus instance to prevent duplicate listener registration on carrier reconnect.
  const boundBusRef = useRef(null);

  const handleBusReady = useCallback((bus, auth) => {
    applyApproval(APPROVAL_STATUS.reconnect);
    // Invalidate cached lists on reconnect until refetched.
    resetLoaded("pm-connect");

    if (boundBusRef.current === bus) {
      fetchLists(bus);
      return;
    }
    boundBusRef.current = bus;

    bus.on("device:pendingApproval", () => {
      termLog("diag", "EVENT device:pendingApproval arrived");
      debugLog("auth", "[auth] agent says: waiting for host approval");
      applyApproval(APPROVAL_STATUS.pending);
    });

    bus.on("device:approved", () => {
      termLog("diag", "EVENT device:approved arrived → applying");
      applyApproval(APPROVAL_STATUS.approved);
      setAdmitted(true);
      // Persist key now that agent has verified and accepted it.
      commitPendingKey();
      removeTempKey();
    });

    // terminal:ready signals handlers are registered, but is not an admission verdict.
    bus.on("terminal:ready", () => {
      debugLog("auth", "[auth] terminal:ready (NOT an admission signal)");
      fetchLists(bus);
    });

    // Re-assert readiness and refetch lists on carrier reconnect.
    bus.on("connect", () => {
      resetLoaded("carrier-connect");
      bus.emit("device:clientReady");
      announceCaps(bus);
      fetchLists(bus);
    });

    bus.on("device:rejected", () => {
      termLog("diag", "EVENT device:rejected arrived → applying");
      applyApproval(APPROVAL_STATUS.rejected);
      // Stop auto-reconnect — user must re-submit key to try again
      disconnectRef.current?.();
    });

    bus.on("device:tailRejected", (data) => {
      // seal-unreadable = stale pin (agent rotated its host key): deviceTrust drops pin and retries.
      if (data?.reason === TAIL_REJECT_REASON.sealUnreadable) return;
      // Failed tail verification drops session and redirects to login with error reason.
      disconnectRef.current?.();
      const auth = getAuth();
      forgetRejectedTail(auth?.apiKey);
      forgetRejectedTail(auth?.tempKey);
      sessionStorage.clear();
      sessionStorage.setItem(LOGIN_ERROR_KEY, data?.reason || TAIL_REJECT_REASON.mismatch);
      window.location.replace("/login");
    });

    bus.on("serverInfo", (info) => {
      setRemoteAvailable(info.remoteAvailable);
      setMobileAvailable(!!info.mobileAvailable);
      setPlatform(info.platform);
      setAgentVersion(info.version || null);
      setUpdateAvailable(info.updateAvailable || null);
      setCanSelfUpdate(!!info.canSelfUpdate);
      useTerminalStore.getState().setAgentCaps(info.caps || {});
      useTerminalStore.getState().setArtifactEnabled(info.artifactEnabled);
      useTerminalStore.getState().setMcpClients(info.mcpClients);
      if (info.voiceConfig) {
        useVoiceStore.getState().syncFromAgent(info.voiceConfig);
      } else {
        const s = useVoiceStore.getState();
        const hasConfig = s.geminiKeys.some((k) => k.trim()) || s.openrouterKey || s.customKey || s.customEndpoint;
        if (hasConfig) s.pushToAgent();
      }
      if (info.isCodespaces) {
        setCodespaceInfo({ isCodespaces: info.isCodespaces, codespaceName: info.codespaceName });
      }
    });

    bus.on("sessionClosed", (sessionId) => {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      // Clean up terminal store state for closed session.
      useTerminalStore.getState().closeSession(sessionId);
    });

    // The agent renames a terminal on its own once its conversation has a title.
    bus.on("session-renamed", ({ sessionId, name } = {}) => {
      if (!sessionId) return;
      setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, name } : s)));
    });

    // Update session agent surface and invalidate history cache when mode changes.
    bus.on("sessionAgentChanged", ({ sessionId, agent } = {}) => {
      if (!sessionId || !agent) return;
      useTerminalStore.getState().setSessionAgent(sessionId, agent);
      useTerminalStore.getState().invalidateAgentHistory();
    });

    // A terminal opened on another device; force, or the freshness guard eats it.
    bus.on("sessionsChanged", () => fetchLists(bus, true));

    bus.on("workspacesChanged", () => fetchLists(bus));

    bus.on("codespace:stopping", handleCodespaceStopping);

    // Announce capabilities on first bind in addition to carrier reconnects.
    announceCaps(bus);

    bus.emit("device:clientReady");
  }, [removeTempKey, handleCodespaceStopping, fetchLists, applyApproval, getAuth, resetLoaded]);

  const { bus, busRef, protocolRef, connected, connectionMode, carrier, retryStatus, disconnect } = useBus({
    namespace: "",
    redirectOnNoAuth: "/",
    onConnect: handleBusReady,
    onDisconnect: handleDisconnect,
    // Agent refused over signaling — same funnel as the socket.io device:* events
    onApproval: applyApproval
  });

  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);

  const loadSessions = useCallback(() => fetchLists(busRef.current), [busRef, fetchLists]);

  // Force refresh lists bypassing the freshness guard.
  const refreshLists = useCallback(() => fetchLists(busRef.current, true), [busRef, fetchLists]);

  // Pending coalesce timer must not outlive the hook.
  useEffect(() => () => {
    if (fetchTimerRef.current) { clearTimeout(fetchTimerRef.current); fetchTimerRef.current = null; }
  }, []);

  // terminal:ready is one-shot over a racy multi-carrier transport — if it or a fetch
  // ack is dropped, the lists stay empty forever. Retry while connected until each
  // list has ever received a response; receiving [] also counts (stops forever then).
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      if (bothLoaded()) return;
      termLog("diag", `list-retry tick: connected but not loaded (sessions=${loadedRef.current.sessions} workspaces=${loadedRef.current.workspaces}) — refetching`); // TEMP DIAGNOSTIC
      loadSessions();
    }, 2000);
    return () => clearInterval(timer);
  }, [connected, loadSessions]);

  // Refetch lists when tab becomes visible if connected.
  useEffect(() => {
    if (!connected) return;
    const refetch = () => {
      if (document.visibilityState !== "visible") return;
      loadSessions();
    };
    refetch();
    document.addEventListener("visibilitychange", refetch);
    return () => document.removeEventListener("visibilitychange", refetch);
  }, [connected, loadSessions]);

  // Create session; nameIsAuto indicates UI-generated placeholder name.
  const createSession = useCallback((name, shellId, workspaceId, cwd, callback, nameIsAuto = false, agent = null, replaces = null) => {
    if (!busRef.current) return;
    // Backward compat: createSession(name, callback) / createSession(name, shellId, callback)
    if (typeof shellId === "function") { callback = shellId; shellId = null; workspaceId = null; cwd = null; }
    else if (typeof workspaceId === "function") { callback = workspaceId; workspaceId = null; cwd = null; }
    else if (typeof cwd === "function") { callback = cwd; cwd = null; }

    const agentId = typeof agent === "string" ? agent : agent?.id || null;
    busRef.current.emit("createSession", { name, shellId, workspaceId, cwd, nameIsAuto, agent: agentId, replaces }, (result) => {
      if (result?.success) {
        if (result.sessionId) {
          if (agentId) useTerminalStore.getState().setSessionAgent(result.sessionId, agentId);
          const wsPath = workspaces.find((w) => w.id === workspaceId)?.path || null;
          setSessions((prev) => [
            // The terminal this one replaced goes in the same update to avoid holding both.
            ...prev.filter((s) => s.id !== result.sessionId && s.id !== result.replaced),
            {
              id: result.sessionId,
              name: result.name || name || "Terminal",
              createdAt: Date.now(),
              cwd: result.cwd || cwd || null,
              workspaceId: workspaceId || null,
              groupId: workspaceId || null,
              workspacePath: wsPath,
              shellId: result.shellId || shellId || null,
              shellLabel: result.shellLabel || null,
              agent: agentId || null
            }
          ]);
        }
        refreshLists();
      }
      callback?.(result);
    });
  }, [busRef, refreshLists, workspaces]);

  const createWorkspace = useCallback((name, wsPath, callback) => {
    if (typeof wsPath === "function") { callback = wsPath; wsPath = null; }
    busRef.current?.emit("createWorkspace", { name, path: wsPath }, (result) => { if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const renameWorkspace = useCallback((workspaceId, name, callback) => {
    busRef.current?.emit("renameWorkspace", { workspaceId, name }, (result) => { if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const deleteWorkspace = useCallback((workspaceId, callback) => {
    busRef.current?.emit("deleteWorkspace", { workspaceId }, (result) => { if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const setWorkspaceHiddenRepos = useCallback((workspaceId, paths, callback) => {
    busRef.current?.emit("setWorkspaceHiddenRepos", { workspaceId, paths }, (result) => { if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const moveSession = useCallback((sessionId, workspaceId, callback) => {
    busRef.current?.emit("moveSession", { sessionId, workspaceId }, (result) => { if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const reorderSession = useCallback((orderedIds, callback) => {
    busRef.current?.emit("reorderSession", { orderedIds }, (result) => { if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const getShells = useCallback((callback) => {
    if (!busRef.current) return;
    busRef.current.emit("getShells", (result) => callback?.(result));
  }, [busRef]);

  const deleteSession = useCallback((sessionId, callback) => {
    if (!busRef.current) return;

    busRef.current.emit("deleteSession", sessionId, (result) => {
      if (result.success) refreshLists();
      callback?.(result);
    });
  }, [busRef, refreshLists]);

  const renameSession = useCallback((sessionId, newName, callback) => {
    if (!busRef.current) return;

    busRef.current.emit("renameSession", { sessionId, name: newName }, (result) => {
      if (result.success) refreshLists();
      callback?.(result);
    });
  }, [busRef, refreshLists]);

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

  // Trigger agent self-update via bus (authenticated, survives tunnel restart)
  const triggerUpdate = useCallback(() => {
    const sock = busRef.current;
    if (!sock?.connected) return false;
    protocolRef.current?.setUpdating?.(true);
    sock.emit("requestUpdate");
    return true;
  }, [busRef, protocolRef]);

  // Restart agent host (no reinstall): kill + relaunch, ptyDaemon survives
  const triggerRestart = useCallback(() => {
    const sock = busRef.current;
    if (!sock?.connected) return false;
    protocolRef.current?.setUpdating?.(true);
    sock.emit("requestRestart");
    return true;
  }, [busRef, protocolRef]);

  return {
    bus,
    busRef,
    protocolRef,
    connected,
    connectionMode,
    carrier,
    retryStatus,
    approvalStatus,
    admitted,
    sessions,
    remoteAvailable,
    mobileAvailable,
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
