import { useEffect, useState, useCallback, useRef } from "react";
import { useBus } from "@/shared/hooks/useBus";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { commitPendingKey, forgetRejectedTail } from "@/shared/transport/lib/deviceTrust";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { WORKER_API } from "@/shared/constants/API";
import { TAIL_REJECT_REASON, LOGIN_ERROR_KEY, APPROVAL_STATUS } from "@/shared/constants/transport";
import { sameList } from "@/shared/utils/shallowEqual";
import { termLog } from "@/shared/utils/termLog";
import { debugLog } from "@/shared/utils/debugLog";

// Resume on mobile triggers several list-refresh paths within a few ms; this
// window collapses them into one round-trip.
const FETCH_COALESCE_MS = 120;
// The two carriers (RTC, then WS ~200ms later) each announce terminal:ready, and the
// resume/retry effects fire alongside them. Past the coalesce window they still describe
// the SAME load, so a fetch this soon after the last one is dropped rather than repeated.
// CRUD refreshes pass force and ignore this.
const FETCH_FRESH_MS = 1000;

// The agent-facing hook: owns the transport bus and every agent event the
// workspace reacts to (sessions, workspaces, approval, agent version).
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
  // A carrier being open is not the same as the agent having let us in: the
  // TAIL is proven after the bus connects, so there is a window where we are
  // "connected" but not admitted. Sticky for the page's lifetime — a later
  // carrier flap must not re-gate a session the agent already accepted.
  const [admitted, setAdmitted] = useState(false);
  const { getAuth } = useSessionStorage();

  // Approval arrives on TWO independent carriers — socket.io device:* events
  // and the DO signaling relay (which answers before any bus exists). Both
  // funnel through here so the verdict follows one set of rules instead of
  // whichever path happened to fire last.
  //   pending/rejected  = a policy answer from the host; only the host changes it
  //   approved          = terminal for this session
  //   carrier-reconnect = NOT an answer, must never clear a standing verdict
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

  // Ref to the disconnect function from useBus (set below).
  // Needed here because bus.on("device:rejected") must call it, but it's defined after.
  const disconnectRef = useRef(null);

  // Whether each list has ever received a response — gates the retry below.
  // An empty [] response counts; only lost packets keep retrying.
  const loadedRef = useRef({ sessions: false, workspaces: false });
  // "Both lists answered" is asked from three places (the two reset sites, the
  // freshness guard, the retry loop) — one definition so they cannot disagree.
  const bothLoaded = () => loadedRef.current.sessions && loadedRef.current.workspaces;

  const markLoaded = (key) => { loadedRef.current[key] = true; };

  const resetLoaded = useCallback((why) => {
    termLog("switch", `lists untrusted (${why}) → refetch`);
    loadedRef.current = { sessions: false, workspaces: false };
  }, []);

  // A non-array ack is a carrier failure, not an answer: PM rejects every pending ack
  // with { error: "rtc-closed" } when RTC dies. Marking it loaded would stop the retry
  // below forever and leave the lists empty until a full reload.
  const applySessions = useCallback((list) => {
    if (!Array.isArray(list)) return;
    markLoaded("sessions");
    for (const s of list) {
      if (s?.id && s?.agent) {
        useTerminalStore.getState().setSessionAgent(s.id, s.agent);
      }
    }
    // Four sources refetch this list, one of them on every return to the tab, and the
    // answer is nearly always what we already have. Keeping the old array keeps every
    // consumer's identity check true instead of re-rendering the whole workspace.
    setSessions((prev) => (sameList(prev, list) ? prev : list));
  }, []);

  const applyWorkspaces = useCallback((list) => {
    if (!Array.isArray(list)) return;
    markLoaded("workspaces");
    setWorkspaces((prev) => (sameList(prev, list) ? prev : list));
  }, []);

  // Four independent sources ask for these lists (terminal:ready, the bus
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
  const lastFetchAtRef = useRef(0);

  const emitSessions = useCallback((bus) => {
    const seq = ++sessionSeqRef.current;
    bus.emit("getSessions", (list) => { // TEMP DIAGNOSTIC — bug: stuck loading after key login
      termLog("diag", `getSessions ack seq=${seq} type=${Array.isArray(list) ? "list" : typeof list} n=${Array.isArray(list) ? list.length : "-"}`);
      if (seq === sessionSeqRef.current) applySessions(list);
    });
  }, [applySessions]);

  const emitWorkspaces = useCallback((bus) => {
    const seq = ++workspaceSeqRef.current;
    bus.emit("getWorkspaces", (list) => { if (seq === workspaceSeqRef.current) applyWorkspaces(list); });
  }, [applyWorkspaces]);

  // THE one door to both lists: every trigger (terminal:ready per carrier, bus connect,
  // visibility, retry, CRUD) funnels here so a load is one round-trip per list, not one per
  // trigger. force = a local mutation whose result we must see now.
  const fetchLists = useCallback((bus, force = false) => {
    if (!bus) return;
    if (force) clearTimeout(fetchTimerRef.current); // restart so the emit lands after THIS write
    else if (fetchTimerRef.current) return; // burst already pending
    else if (bothLoaded() && Date.now() - lastFetchAtRef.current < FETCH_FRESH_MS) return;
    fetchTimerRef.current = setTimeout(() => {
      fetchTimerRef.current = null;
      lastFetchAtRef.current = Date.now();
      termLog("diag", `fetchLists FIRE (bus=${bus ? "ok" : "null"} connected-already=${loadedRef.current.sessions}/${loadedRef.current.workspaces})`); // TEMP DIAGNOSTIC
      emitWorkspaces(bus);
      emitSessions(bus);
    }, FETCH_COALESCE_MS);
  }, [emitSessions, emitWorkspaces]);

  // What this client understands. Sent once on first bind and again on every
  // carrier rejoin — the agent gates __ping (hb), binary output (binOut),
  // fragmented prefixes (fragOut) and its v2 sender (env2) on this announcement.
  // fragCtl is this side of the same bargain: the agent may slice an oversize
  // control envelope at us only because we reassemble it.
  const CAPS = { fragOut: true, binOut: true, hb: 1, env2: 1, fragCtl: 1 };
  const announceCaps = (bus) => {
    termLog("switch", `caps → ${JSON.stringify(CAPS)} announced`);
    bus.emit("caps", CAPS);
  };

  // The bus this hook's listeners are bound to. onConnect fires again on every
  // carrier reconnect after a full outage, but the bus — and everything registered
  // on it — survives, so re-binding would stack a fresh closure set per outage.
  // A new ProtocolManager hands out a new bus, which is exactly when rebinding IS
  // wanted (see web/test/clientBusIntegration.test.mjs).
  const boundBusRef = useRef(null);

  const handleBusReady = useCallback((bus, auth) => {
    // A carrier coming up is not a verdict — see applyApproval.
    applyApproval(APPROVAL_STATUS.reconnect);
    // A reconnect may have missed create/delete done elsewhere while we were away,
    // so neither list is trustworthy until the agent answers again.
    resetLoaded("pm-connect");

    if (boundBusRef.current === bus) {
      fetchLists(bus);
      return;
    }
    boundBusRef.current = bus;

    // Listen for device approval flow
    bus.on("device:pendingApproval", () => {
      termLog("diag", "EVENT device:pendingApproval arrived");
      debugLog("auth", "[auth] agent says: waiting for host approval");
      applyApproval(APPROVAL_STATUS.pending);
    });

    bus.on("device:approved", () => {
      termLog("diag", "EVENT device:approved arrived → applying"); // TEMP DIAGNOSTIC
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
    bus.on("terminal:ready", () => {
      debugLog("auth", "[auth] terminal:ready (NOT an admission signal)");
      fetchLists(bus);
    });

    // Carrier rejoin (resume from background, RTC<->WS switch). The agent keeps the
    // same session, so it may not re-emit "terminal:ready" — refetch here or the
    // lists keep showing what was true before the device went to sleep.
    // clientReady re-asserts per connection: onConnect above fires once per PM
    // lifetime, but the agent defers per-bus device:* answers on this event —
    // a reconnect that skips it (e.g. zombie RTC kept "connected") would never
    // get its pending/approved notification.
    bus.on("connect", () => {
      resetLoaded("carrier-connect");
      bus.emit("device:clientReady");
      announceCaps(bus);
      fetchLists(bus);
    });

    bus.on("device:rejected", () => {
      termLog("diag", "EVENT device:rejected arrived → applying"); // TEMP DIAGNOSTIC
      applyApproval(APPROVAL_STATUS.rejected);
      // Stop auto-reconnect — user must re-submit key to try again
      disconnectRef.current?.();
    });

    bus.on("device:tailRejected", (data) => {
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
      if (info.isCodespaces) {
        setCodespaceInfo({ isCodespaces: info.isCodespaces, codespaceName: info.codespaceName });
      }
    });

    bus.on("sessionClosed", (sessionId) => {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      // Drop everything else keyed by this terminal in the same breath: a pane
      // left open on a dead id renders nothing, and a history row still pointing
      // at it would focus a terminal that isn't there.
      useTerminalStore.getState().closeSession(sessionId);
    });

    // The agent renames a terminal on its own once its conversation has a title,
    // so the name can change without this client having asked for it.
    bus.on("session-renamed", ({ sessionId, name } = {}) => {
      if (!sessionId) return;
      setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, name } : s)));
    });

    // The host switched a terminal between its CLI and the chat UI, so the pane
    // this client renders for it is no longer the right one. The history rows
    // carry that surface too, so they are re-read rather than waiting out the poll.
    bus.on("sessionAgentChanged", ({ sessionId, agent } = {}) => {
      if (!sessionId || !agent) return;
      useTerminalStore.getState().setSessionAgent(sessionId, agent);
      useTerminalStore.getState().invalidateAgentHistory();
    });

    // Workspaces changed elsewhere — refresh both lists
    bus.on("workspacesChanged", () => fetchLists(bus));

    bus.on("codespace:stopping", handleCodespaceStopping);

    // The "connect" listener above only fires on LATER carrier changes (a rejoin):
    // on the first bind the link is already up before that listener exists, so the
    // agent would never learn our capabilities — no __ping heartbeat, no binary
    // output, no v2 frames from its side. Announce on first bind too; both emits
    // are idempotent on the agent.
    announceCaps(bus);

    // Signal server that client listeners are ready
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

  // Keep ref in sync so event handlers registered above can call disconnect
  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);

  // The one public refresh (mount, visibility, retry). Both lists always travel together —
  // every caller wanted both, and asking separately cost two round-trips for one answer.
  const loadSessions = useCallback(() => fetchLists(busRef.current), [busRef, fetchLists]);

  // Skips the freshness guard. Two callers need that: a local create/rename/delete
  // whose own write must not be hidden, and a resume, where the lists were just
  // declared untrustworthy and a pending burst would land stale.
  const refreshLists = useCallback(() => fetchLists(busRef.current, true), [busRef, fetchLists]);

  // Pending coalesce timer must not outlive the hook — it captures the bus
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
      if (bothLoaded()) return;
      termLog("diag", `list-retry tick: connected but not loaded (sessions=${loadedRef.current.sessions} workspaces=${loadedRef.current.workspaces}) — refetching`); // TEMP DIAGNOSTIC
      loadSessions();
    }, 2000);
    return () => clearInterval(timer);
  }, [connected, loadSessions]);

  // Coming back from background. Carrier events can't be relied on here: if WS stayed
  // up while only RTC died and recovered, the agent keeps the same session (no
  // "terminal:ready") and PM skips the rejoin because the other carrier is ready — so
  // nothing else would refetch, and the lists would still show pre-sleep state.
  // A silent refetch, NOT a reset: becoming visible is not evidence the session
  // broke, and gating on it flashed the overlay every time the user glanced away.
  // Gated on `connected`: with no carrier ready PM buffers control sends in an
  // unbounded array, and a phone toggled on/off while offline would pile them up.
  // Re-running on `connected` also covers becoming visible while still offline.
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

  // Create new session (workspaceId optional). cwd = a folder picked in the tree, else
  // inherited from the last session in the workspace.
  // `nameIsAuto` marks a name the UI filled in rather than the user typing it —
  // the agent keeps renaming such a terminal after the conversation it runs.
  const createSession = useCallback((name, shellId, workspaceId, cwd, callback, nameIsAuto = false, agent = null) => {
    if (!busRef.current) return;
    // Backward compat: createSession(name, callback) / createSession(name, shellId, callback)
    if (typeof shellId === "function") { callback = shellId; shellId = null; workspaceId = null; cwd = null; }
    else if (typeof workspaceId === "function") { callback = workspaceId; workspaceId = null; cwd = null; }
    else if (typeof cwd === "function") { callback = cwd; cwd = null; }

    const agentId = typeof agent === "string" ? agent : agent?.id || null;
    busRef.current.emit("createSession", { name, shellId, workspaceId, cwd, nameIsAuto, agent: agentId }, (result) => {
      if (result?.success) {
        if (result.sessionId) {
          if (agentId) useTerminalStore.getState().setSessionAgent(result.sessionId, agentId);
          const wsPath = workspaces.find((w) => w.id === workspaceId)?.path || null;
          setSessions((prev) => [
            ...prev.filter((s) => s.id !== result.sessionId),
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

  // Workspace CRUD + move
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

  // Reorder sessions within a workspace; orderedIds = desired order of its sessions
  const reorderSession = useCallback((orderedIds, callback) => {
    busRef.current?.emit("reorderSession", { orderedIds }, (result) => { if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  // Fetch available shells from agent
  const getShells = useCallback((callback) => {
    if (!busRef.current) return;
    busRef.current.emit("getShells", (result) => callback?.(result));
  }, [busRef]);

  // Delete session
  const deleteSession = useCallback((sessionId, callback) => {
    if (!busRef.current) return;

    busRef.current.emit("deleteSession", sessionId, (result) => {
      if (result.success) refreshLists();
      callback?.(result);
    });
  }, [busRef, refreshLists]);

  // Rename session
  const renameSession = useCallback((sessionId, newName, callback) => {
    if (!busRef.current) return;

    busRef.current.emit("renameSession", { sessionId, name: newName }, (result) => {
      if (result.success) refreshLists();
      callback?.(result);
    });
  }, [busRef, refreshLists]);

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
