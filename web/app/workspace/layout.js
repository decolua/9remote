"use client";

import { useEffect, useState, useCallback, useMemo, useRef, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useAgentBus } from "@/features/session/hooks/useAgentBus";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useShallow } from "zustand/react/shallow";
import { useUIStore } from "@/shared/stores/uiStore";
import { useFileBus } from "@/features/fileExplorer/hooks/useFileBus";
import DevTermLog from "@/features/terminal/components/DevTermLog";
import { getRecentWorkspaces, addRecentWorkspace, updateOpenedFiles } from "@/features/fileExplorer/components/WorkspaceList";
import { isDiffPath, parseRepoDiffPath } from "@/features/fileExplorer/constants/fileExplorer";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useNotification } from "@/shared/hooks/useNotification";
import { updateTitle } from "@/shared/utils/titleMarquee";
import { startWidthDrag } from "@/shared/utils/dragResize";
import { DESKTOP_BREAKPOINT } from "@/features/terminal/constants/terminalConfig";
import { usePwaInstallInit } from "@/features/terminal/hooks/usePwaInstallInit";
import { useSwipeTab } from "@/features/terminal/hooks/useSwipeTab";
import { useTerminalPageViewport } from "@/features/terminal/hooks/useTerminalPageViewport";
import { useWorkspaceFileNav } from "@/features/fileExplorer/hooks/useWorkspaceFileNav";
import { usePaneRegistry } from "@/features/terminal/hooks/usePaneRegistry";
import { useSessionNavigation } from "@/features/terminal/hooks/useSessionNavigation";
import { scopedFleetLists, rawWsIdOf, scopeOf } from "@/features/hosts/lib/fleetTree";
import { makeFleetActions } from "@/features/hosts/lib/fleetActions";
import { useResumeGrace } from "@/shared/hooks/useResumeGrace";
import { useGlobalShortcuts } from "@/shared/hooks/useGlobalShortcuts";
import { useShortcutsModalStore } from "@/shared/stores/shortcutsModalStore";
import { useAgentClis } from "@/features/terminal/hooks/useAgentClis";
import { useMobileDeviceWatch } from "@/features/mobile/hooks/useMobileDeviceWatch";
import { loadTerminalPrefs, applySkipPermissions } from "@/features/terminal/constants/agentCli";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import { AI_UI_OPTIONS } from "@/features/ai/constants";
import TerminalWorkspace from "@/features/terminal/components/TerminalWorkspace";
import ReconnectScreen from "@/features/session/components/ReconnectScreen";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";
import { headOf, tailOf } from "@/shared/utils/apiKey";
import { setTrust } from "@/shared/transport/lib/deviceTrust";
import { isLoopbackOrigin } from "@/shared/utils/localOrigin";
import { AGENT_PORT, LOCAL_AGENT_STATE } from "@/shared/constants/API";

import SessionList from "@/features/session/components/SessionList";
import { useFleetStore, emitWhenReady } from "@/shared/stores/fleetStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { connOf } from "@/shared/transport/hostConn";
import { useApiKeyStorage, KEYS_CHANGED_EVENT } from "@/shared/hooks/useApiKeyStorage";
import RemoteDesktop from "@/features/remote/components/RemoteDesktop";
import MobileMirror from "@/features/mobile/components/MobileMirror";
import BrowserView from "@/features/browser/components/BrowserView";
import WorkspaceList from "@/features/fileExplorer/components/WorkspaceList";
import FileExplorer from "@/features/fileExplorer/components/FileExplorer";
import FileEditor from "@/features/fileExplorer/components/FileEditor";
import GitPanel from "@/features/fileExplorer/components/GitPanel";
import FileWorkspaceDesktop from "@/features/fileExplorer/components/FileWorkspaceDesktop";
import FolderPickerModal from "@/features/terminal/components/FolderPickerModal";
import CommandPalette from "@/features/fileExplorer/components/CommandPalette";
import ShortcutsModal from "@/shared/components/ui/ShortcutsModal";
import ConnectionModal from "@/shared/components/ui/ConnectionModal";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import SlideMenu from "@/shared/components/ui/SlideMenu";
import { useI18n } from "@/shared/i18n";
import { useRouteSync } from "@/shared/hooks/useRouteSync";
import { useLastRoute } from "@/shared/hooks/useLastRoute";
import { viewToPath } from "@/features/terminal/constants/routeConfig";

function RouteSyncTracker({ hydrated, apiKey }) {
  useRouteSync(hydrated);
  useLastRoute(apiKey);
  return null;
}

// Workspace shell - holds the bus/state/views; child routes are URL markers only
export default function WorkspaceLayout({ children }) {
  const { t } = useI18n();
  const [hydrated, setHydrated] = useState(false);
  // Capture PWA beforeinstallprompt as early as possible (Chromium-only)
  usePwaInstallInit();

  const {
    viewStack,
    openedSessions,
    pushView,
    popView: storePopView,
    setViewStack,
    addOpenedSession,
    removeOpenedSession,
    reorderOpenedSessions,
    activeWorkspaceId,
    setActiveWorkspaceId,
    livePanes,
    touchLivePane,
    mountedWorkspaces,
    markWorkspaceMounted,
    reset: resetStore,
    cwdBySession,
    sidebarCollapsed,
    toggleSidebar,
    sidebarWidth,
    setSidebarWidth,
    paneWidths,
    setPaneWidth,
    rightPanelOpen,
    rightPanelTabs,
    rightPanelWidth,
    toggleRightPanel,
    setRightPanelTab,
    setRightPanelWidth,
    editorFilePath,
    editorPanelWidth,
    setEditorPanelWidth,
    openEditorFile,
    closeEditorFile,
    editorPreviewSeq,
    mobileOpen,
    mobileMode,
    mobilePanelWidth,
    setMobileOpen,
    setMobileMode,
    setMobilePanelWidth,
    setMobileSession,
    artifactTitle,
    pushArtifact,
    removeArtifact
  } = useTerminalStore(useShallow((s) => ({
    viewStack: s.viewStack,
    openedSessions: s.openedSessions,
    pushView: s.pushView,
    popView: s.popView,
    setViewStack: s.setViewStack,
    addOpenedSession: s.addOpenedSession,
    removeOpenedSession: s.removeOpenedSession,
    reorderOpenedSessions: s.reorderOpenedSessions,
    activeWorkspaceId: s.activeWorkspaceId,
    setActiveWorkspaceId: s.setActiveWorkspaceId,
    livePanes: s.livePanes,
    touchLivePane: s.touchLivePane,
    mountedWorkspaces: s.mountedWorkspaces,
    markWorkspaceMounted: s.markWorkspaceMounted,
    reset: s.reset,
    cwdBySession: s.cwdBySession,
    sidebarCollapsed: s.sidebarCollapsed,
    toggleSidebar: s.toggleSidebar,
    sidebarWidth: s.sidebarWidth,
    setSidebarWidth: s.setSidebarWidth,
    paneWidths: s.paneWidths,
    setPaneWidth: s.setPaneWidth,
    rightPanelOpen: s.rightPanelOpen,
    rightPanelTabs: s.rightPanelTabs,
    rightPanelWidth: s.rightPanelWidth,
    toggleRightPanel: s.toggleRightPanel,
    setRightPanelTab: s.setRightPanelTab,
    setRightPanelWidth: s.setRightPanelWidth,
    editorFilePath: s.editorFilePath,
    editorPanelWidth: s.editorPanelWidth,
    setEditorPanelWidth: s.setEditorPanelWidth,
    openEditorFile: s.openEditorFile,
    closeEditorFile: s.closeEditorFile,
    editorPreviewSeq: s.editorPreviewSeq,
    mobileOpen: s.mobileOpen,
    mobileMode: s.mobileMode,
    mobilePanelWidth: s.mobilePanelWidth,
    setMobileOpen: s.setMobileOpen,
    setMobileMode: s.setMobileMode,
    setMobilePanelWidth: s.setMobilePanelWidth,
    setMobileSession: s.setMobileSession,
    artifactTitle: s.artifactTitle,
    pushArtifact: s.pushArtifact,
    removeArtifact: s.removeArtifact,
  })));

  const router = useRouter();
  const { getAuth, setAuth } = useSessionStorage();
  const [auth, setAuthState] = useState(() => getAuth());
  // Host switching re-keys in place: authKey is the reactive mirror of
  // sessionStorage, so re-derive everything that read auth once at mount.
  const authKey = useConnectionStore((s) => s.authKey);
  useEffect(() => {
    if (authKey) setAuthState(getAuth());
  }, [authKey, getAuth]);

  useEffect(() => {
    setHydrated(true);
    // Only the agent's own port: there the agent serves the page and holds the
    // key, so a reload must not dump the user back on the login screen. A page
    // on the web dev server is loopback too — it logs in like any other build.
    if (!auth?.apiKey && isLoopbackOrigin() && window.location.port === String(AGENT_PORT)) {
      fetch(LOCAL_AGENT_STATE)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.permanentKey) {
            const fullKey = data.permanentKey;
            const head = headOf(fullKey);
            const tail = tailOf(fullKey);
            setTrust(head, { tail });
            const a = { apiKey: head, tunnelUrl: window.location.origin, mode: "local", tempKey: null, localIp: null };
            setAuth(a);
            setAuthState(a);
          }
        })
        .catch(() => {});
    }
  }, [auth, setAuth]);

  // Tauri shell has no browser reload accelerator — wire Cmd/Ctrl+R and F5.
  // Suppress native browser contextmenu in desktop app except for editable text inputs.
  useEffect(() => {
    if (!window.__TAURI__) return;
    const onKey = (e) => {
      const isReload = e.key === "F5" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r");
      if (isReload) { e.preventDefault(); window.location.reload(); }
    };
    const onContextMenu = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);
  const { bus, busRef, protocolRef, disconnect, connected, connectionMode, carrier, remoteAvailable, mobileAvailable, platform, agentVersion, retryStatus, approvalStatus, admitted, loadSessions, createSession, deleteSession, renameSession, createWorkspace, renameWorkspace, deleteWorkspace, setWorkspaceHiddenRepos, reorderSession } = useAgentBus();
  // Fleet: one background bus per saved host other than the current one; the
  // mobile home shows the fleet overview until the user enters a host (focus).
  const { loadKeys, saveKey, renameKey, removeKey } = useApiKeyStorage();
  const [savedKeys, setSavedKeys] = useState([]);
  useEffect(() => {
    if (!hydrated) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe read after mount
    setSavedKeys(loadKeys());
  }, [hydrated, loadKeys]);
  // Saved keys change from anywhere (add-host modal in sidebar/list/tree-row,
  // rename, delete) — one listener keeps this state honest, no callback threading.
  useEffect(() => {
    if (!hydrated) return;
    const refresh = () => setSavedKeys(loadKeys());
    window.addEventListener(KEYS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(KEYS_CHANGED_EVENT, refresh);
  }, [hydrated, loadKeys]);
  const currentFleetKey = auth?.apiKey ? headOf(auth.apiKey) : "";
  // Cache scope of the HOST this connection serves: switchHost makes another key this
  // connection, so the legacy "" bucket must not leak one machine's recents into it.
  const connScope = scopeOf(currentFleetKey || null);
  useEffect(() => {
    if (!hydrated) return;
    // Logged out — drop every fleet bus so agent data stops flowing to a session
    // that just signed out (the buses are module-level and survive unmount).
    if (!currentFleetKey) { useFleetStore.getState().closeAll(); return; }
    useFleetStore.getState().sync(savedKeys, currentFleetKey);
  }, [hydrated, savedKeys, currentFleetKey]);
  // Other hosts' sessions/workspaces, workspace ids scoped "head:" — they ride the
  // SAME workspace model (nav, panes, tabs) as the main host's, so a foreign
  // terminal opens as a real parallel tab instead of a host switch.
  const fleetHostsMap = useFleetStore((s) => s.hosts);
  // Single lane: the main host's lists ride the fleet store entry like every other
  // host. Memoized so the [] fallback keeps one identity across renders.
  const mainHost = fleetHostsMap[currentFleetKey];
  const sessions = useMemo(() => mainHost?.sessions || [], [mainHost]);
  const workspaces = useMemo(() => mainHost?.workspaces || [], [mainHost]);
  const scopedLists = useMemo(
    () => scopedFleetLists(Object.values(fleetHostsMap), currentFleetKey),
    [fleetHostsMap, currentFleetKey]
  );
  const allSessions = useMemo(
    () => [...sessions, ...scopedLists.sessions],
    [sessions, scopedLists]
  );
  const allWorkspaces = useMemo(
    () => [...workspaces, ...scopedLists.workspaces],
    [workspaces, scopedLists]
  );
  // Home defaults to the host's own session list; the fleet view only ever opens
  // as the Settings overlay.

  // Rename a saved host: the storage entry is keyed by id, the fleet row by key HEAD.
  const handleRenameHost = useCallback((key, label) => {
    const item = loadKeys().find((k) => headOf(k.key) === key);
    if (!item) {
      saveKey(key, label);
      return;
    }
    renameKey(item.id, label);
  }, [loadKeys, renameKey, saveKey]);

  const [shells, setShells] = useState([]);

  // Per-host update state lives in the fleet store; this hook only keeps the
  // PWA resume grace that suppresses connection modals after a tab reopens.
  const resumeGrace = useResumeGrace();
  // The active host's bus from the store stays set across a transient disconnect
  // (the live ref nulls out), so an in-flight self-update must not flip the page
  // back to the full-screen loading gate.
  const stableBus = useConnectionStore((s) => s.bus);
  const mainHostUpdating = !!mainHost?.updating;
  // Self-update aftermath for the ACTIVE host: reconnect with a new version
  // reloads once (loopback serves the web from the agent — fresh agent means a
  // fresh bundle); a plain restart just clears the row's progress.
  const updateSnapRef = useRef({ armed: false, version: null, dropped: false });
  useEffect(() => {
    if (!mainHost || !currentFleetKey) return;
    const snap = updateSnapRef.current;
    if (!mainHost.updating) { snap.armed = false; snap.dropped = false; return; }
    if (!snap.armed) { snap.armed = true; snap.version = mainHost.version || null; }
    if (!connected) snap.dropped = true;
    if (snap.dropped && connected) {
      // serverInfo (and with it the new version) lands right after the carrier
      // reconnects — settle a beat later so the comparison sees it.
      const timer = setTimeout(() => {
        const h = useFleetStore.getState().hosts[currentFleetKey];
        if (h?.version && snap.version && h.version !== snap.version) window.location.reload();
        else useFleetStore.getState()._patchHost(currentFleetKey, { updating: false });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [mainHost, mainHostUpdating, connected, currentFleetKey]);

  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false, title: "", message: "", onConfirm: null, confirmText: null });

  // Hardcoded Windows shell picker: Command Prompt + PowerShell only.
  // Non-Windows hides the picker. Override the agent-reported list intentionally.
  useEffect(() => {
    if (!connected) return;
    if (platform === "win32") {
      setShells([
        { id: "cmd", label: "Command Prompt" },
        { id: "powershell", label: "PowerShell" }
      ]);
    } else {
      setShells([]);
    }
  }, [connected, platform]);

  const fileBus = useFileBus();
  // Session-long, so the header button reflects a running device even with the
  // mirror panel closed.
  useMobileDeviceWatch();
  const { subscribeToPush, unsubscribeFromPush, notifications } = useNotification(busRef, connected);

  const setKeyboardOpen = useUIStore((state) => state.setKeyboardOpen);

  // Desktop split-view detection
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= DESKTOP_BREAKPOINT : false
  );
  const bindSwipeTab = useSwipeTab();
  useEffect(() => {
    let timerId = 0;
    const check = () => {
      clearTimeout(timerId);
      timerId = setTimeout(() => setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT), 50);
    };
    window.addEventListener("resize", check);
    return () => {
      clearTimeout(timerId);
      window.removeEventListener("resize", check);
    };
  }, []);

  // Current view is top of stack (guard against empty/corrupted viewStack)
  const currentView = viewStack[viewStack.length - 1] || { type: "list" };
  // Desktop has no session-list screen, so the bottom of the stack ("list") shows the
  // terminal shell instead — with its sidebar, and its empty state when nothing is open.
  const isTerminalView = currentView?.type === "terminal" ||
    (isDesktop && currentView?.type === "list");
  // At the bottom of the desktop stack no session is named yet, so fall back to the last
  // one opened — otherwise the shell renders with nothing focused.
  const activeSessionId = currentView?.type === "terminal"
    ? currentView.sessionId
    : (isTerminalView ? openedSessions[openedSessions.length - 1] || null : null);

  const paneRegistry = usePaneRegistry({ isDesktop, isTerminalView, activeSessionId, currentView, openedSessions });

  const nav = useSessionNavigation({
    sessions: allSessions, currentView, viewStack, setViewStack, pushView, storePopView,
    activeWorkspaceId, setActiveWorkspaceId, activeSessionId,
    addOpenedSession, removeOpenedSession, touchLivePane,
    createSession, deleteSession, renameSession, busRef,
    requestFocus: paneRegistry.requestFocus
  });

  const {
    systemInfo, mobileEditor, setMobileEditor, openFileRef,
    handleOpenWorkspaceList, handleOpenFiles, handleSelectWorkspace, handleBrowseFolder,
    handlePathChange, handleOpenFile, handleOpenGit, handleSetWorkspace
  } = useWorkspaceFileNav({ pushView, viewStack, setViewStack, currentView, cwdBySession, sessions, isDesktop, fileBus, scope: connScope });

  // Folder picker → create a workspace rooted there, then offer its first terminal.
  const [folderPicker, setFolderPicker] = useState(null); // { initialPath } | null
  const openSlideMenu = useSlideMenuStore((st) => st.open);
  // Re-read after each workspace change; localStorage is client-only so it stays lazy.
  const recentWorkspaces = useMemo(
    () => (hydrated ? getRecentWorkspaces(connScope) : []),
    [hydrated, workspaces, connScope]
  );

  const createWorkspaceAt = useCallback((folderPath) => {
    setFolderPicker(null);
    if (!folderPath) return;
    const name = folderPath.split("/").filter(Boolean).pop() || folderPath;
    createWorkspace(name, folderPath, (result) => {
      const ws = result?.workspace || result?.group;
      if (!result?.success || !ws?.id) return;
      addRecentWorkspace(folderPath, connScope);
      setActiveWorkspaceId(ws.id);
      nav.handleCreateSession(null, ws.id, null, folderPath);
    });
  }, [createWorkspace, setActiveWorkspaceId, nav]);

  // A path means the user picked a recent folder — skip straight to creating it.
  const openFolderPicker = useCallback((initialPath) => {
    if (initialPath) return createWorkspaceAt(initialPath);
    setFolderPicker({ initialPath: null });
  }, [createWorkspaceAt]);

  // Host-aware terminal create — ONE door for every "+ new terminal": whichever
  // host owns the target workspace gets the session (main via nav, a fleet host
  // via its own bus with the workspace id unscoped).
  const createSessionOnHost = useCallback((name, wsId, shellId, cwd, agent, yolo, nameIsAuto) => {
    // Fallback prefix match: a fleet workspace just created may not be in the
    // merged list yet (refetch pending) — its scoped id still names its host.
    const hostKey = allWorkspaces.find((w) => w.id === wsId)?.hostKey
      || Object.values(fleetHostsMap).find((h) => typeof wsId === "string" && wsId.startsWith(`${h.key}:`))?.key;
    if (hostKey) {
      const host = useFleetStore.getState().hosts[hostKey];
      if (!host) return;
      makeFleetActions(host, { onSelectSession: nav.handleSelectSession })
        .createSession(name, rawWsIdOf(wsId, hostKey), shellId, cwd, agent, yolo, nameIsAuto);
      return;
    }
    nav.handleCreateSession(name, wsId, shellId, cwd, agent, yolo, nameIsAuto);
  }, [allWorkspaces, fleetHostsMap, nav]);

  // Resume a past conversation on whichever host owns the active terminal — the
  // sidebar's history panel follows the focused pane across machines. Mirrors
  // nav.handleResumeAgentSession's post-flow (startup line, agent pin, claim).
  const resumeAgentSessionOnHost = useCallback((row) => {
    // The host is the ACTIVE pane's, not necessarily the active workspace's — the
    // New-terminal modal can sit on one host's workspace while another's terminal
    // is focused. The active workspace is the fallback (no session focused yet).
    const hostKey = allSessions.find((s) => s.id === activeSessionId)?.hostKey
      || allWorkspaces.find((w) => w.id === activeWorkspaceId)?.hostKey;
    if (!hostKey || !row?.resume) return;
    const host = useFleetStore.getState().hosts[hostKey];
    if (!host) return;
    const asUi = row.mode === "ui";
    const agent = useTerminalStore.getState().agentClisBy[hostKey]?.list?.find((a) => a.id === row.agent) || null;
    const resumeLine = asUi ? null : applySkipPermissions(agent, row.resume);
    const agentId = asUi ? `${row.agent}-ui` : row.agent;
    // row.cwd is where the conversation lived on THAT machine — the workspace id
    // only supplies grouping, never the directory to run in.
    const rawWs = rawWsIdOf(activeWorkspaceId, hostKey);
    makeFleetActions(host, { onSelectSession: nav.handleSelectSession })
      .createSession(null, rawWs && rawWs !== "_" ? rawWs : null, null, row.cwd || null, null, false, false, (result) => {
        if (!result?.success || !result.sessionId) return;
        if (resumeLine) useTerminalStore.getState().queueStartup(result.sessionId, resumeLine);
        if (agentId) useTerminalStore.getState().setSessionAgent(result.sessionId, agentId);
        emitWhenReady(hostKey, (b) => b.emit("claimAgentSession",
          { sessionId: result.sessionId, agent: agentId, conversationId: row.sessionId },
          () => useTerminalStore.getState().invalidateAgentHistory()));
      });
  }, [allSessions, allWorkspaces, activeSessionId, activeWorkspaceId, nav]);

  // "New terminal here" from the file tree / worktree list — cwd is the clicked folder.
  const createTerminalAt = useCallback((folderPath) => {
    createSessionOnHost(null, activeWorkspaceId, null, folderPath);
  }, [createSessionOnHost, activeWorkspaceId]);

  // Mod+Shift chords for the workspace shell. Desktop-only — a phone has no physical
  // keyboard to serve, and the mobile input bar already owns Tab / Ctrl+1-9.
  // Same cache key the main host's HostTree modal uses (its fleet HEAD), so the
  // shortcut list and the modal share one entry per machine.
  const activeWsHostKey = allWorkspaces.find((w) => w.id === activeWorkspaceId)?.hostKey || null;
  const activeHostKey = activeWsHostKey || currentFleetKey || "main";
  // Keeps the ACTIVE host's agent-CLI cache warm so the Mod+T chord replays prefs
  // against that host even if its modal was never opened this session.
  const activeHostBusRef = connOf(activeWsHostKey).busRef;
  const activeAgentClis = useAgentClis(activeHostBusRef, activeHostKey);
  const openShortcutsModal = useShortcutsModalStore((st) => st.open);
  const shortcutsOpen = useShortcutsModalStore((st) => st.isOpen);
  const closeShortcutsModal = useShortcutsModalStore((st) => st.close);
  const [quickOpen, setQuickOpen] = useState(false);
  const paletteWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)?.path
    || sessions.find((s) => s.id === activeSessionId)?.workspacePath
    || null;

  // Replays the new-terminal modal's last choice (agent + skip-permissions + shell) so
  // the chord opens what the user last opened, not a bare shell. The agent list follows
  // the ACTIVE host — an agent that has since left its PATH falls back to a plain
  // terminal, same as the modal does.
  const createTerminalFromPrefs = useCallback(() => {
    const { agentId, shellId, yolo } = loadTerminalPrefs();
    const allAgents = (activeAgentClis || []).flatMap((a) => {
      const ui = AI_UI_OPTIONS.find((u) => u.aiEngine === a.id);
      return ui ? [a, ui] : a;
    });
    const agent = (agentId && allAgents.find((a) => a.id === agentId)) || null;
    const index = allSessions.filter((s) => sessionWorkspaceId(s) === (activeWorkspaceId ?? null)).length + 1;
    const name = agent ? `${agent.short || agent.label} ${index}` : null;
    createSessionOnHost(name, activeWorkspaceId, agent ? null : shellId, null, agent, yolo, true);
  }, [activeAgentClis, allSessions, activeWorkspaceId, createSessionOnHost]);

  const handleSwitchWorkspace = useCallback((direction) => {
    const ids = workspaces.map((w) => w.id);
    const hasUngrouped = sessions.some((s) => sessionWorkspaceId(s) === null);
    if (hasUngrouped) ids.push(null);
    if (ids.length < 2) return;

    const currentIdx = ids.indexOf(activeWorkspaceId ?? null);
    const idx = currentIdx === -1 ? 0 : currentIdx;
    const nextIdx = direction === "prev"
      ? (idx - 1 + ids.length) % ids.length
      : (idx + 1) % ids.length;
    nav.handleSelectWorkspace(ids[nextIdx]);
  }, [workspaces, sessions, activeWorkspaceId, nav]);

  const handleCloseActiveTerminal = useCallback(() => {
    if (currentView?.type !== "terminal" || !currentView.sessionId) return;
    const session = sessions.find((s) => s.id === currentView.sessionId);
    if (!session) return;
    setConfirmDialog({
      isOpen: true,
      title: t("sessions.deleteTitle"),
      message: t("sessions.deleteMessage", { name: session.name || t("terminal.defaultName") }),
      confirmText: t("common.delete"),
      onConfirm: () => nav.handleDeleteSession(session.id)
    });
  }, [currentView, sessions, nav, t]);

  // Gated on the terminal view too: remote desktop forwards every keystroke to the host
  // machine, and the full-screen file explorer runs its own chord set — neither may be
  // shadowed by a capture-phase listener sitting above them.
  useGlobalShortcuts({
    sessionPrev: () => nav.switchSession("prev"),
    sessionNext: () => nav.switchSession("next"),
    workspacePrev: () => handleSwitchWorkspace("prev"),
    workspaceNext: () => handleSwitchWorkspace("next"),
    sessionIndex: (index) => nav.switchToIndex(index),
    closeTerminal: handleCloseActiveTerminal,
    toggleFocus: () => paneRegistry.toggleInputFocus(activeSessionId),
    fitPanes: () => window.dispatchEvent(new CustomEvent("terminal:fitPanes")),
    newTerminal: createTerminalFromPrefs,
    toggleSidebar,
    toggleRightPanel,
    palette: () => { if (paletteWorkspace) setQuickOpen(true); },
    help: openShortcutsModal
  }, isDesktop && isTerminalView);

  // Side panel's "open full": swap the docked panel for the full editor route. The
  // workspace root rides along so the desktop editor mounts the right tree.
  const openEditorFull = useCallback((filePath) => {
    const ws = workspaces.find(w => w.id === activeWorkspaceId)?.path
      || sessions.find(s => s.id === currentView.sessionId)?.workspacePath
      || null;
    closeEditorFile();
    pushView({ type: "editor", path: filePath, workspace: ws });
  }, [workspaces, activeWorkspaceId, sessions, currentView, pushView, closeEditorFile]);

  // Mobile sheet (git tab) opens files in the full FileEditor overlay — one file UI on
  // the phone. A diff tab id carries a repo-relative path, so resolve it to the file;
  // its status rides along so the editor can show the diff straight away.
  const openSheetFile = useCallback((path, opts = {}) => {
    if (isDiffPath(path)) {
      const { status, repoPath, filePath } = parseRepoDiffPath(path);
      setMobileEditor({
        path: repoPath ? `${repoPath}/${filePath}` : filePath,
        workspace: repoPath || undefined,
        diffStatus: status
      });
      return;
    }
    setMobileEditor({ path, workspace: workspaces.find(w => w.id === activeWorkspaceId)?.path, preview: !!opts.preview, artifactSessionId: opts.artifactSessionId || null });
  }, [workspaces, activeWorkspaceId, setMobileEditor]);

  // Open one artifact from a terminal's stack — the pane's button and an incoming
  // request both land here, so both leave the same trail behind on close.
  const openArtifact = useCallback((sessionId, item) => {
    if (!item?.path) return;
    const title = item.title || item.path.split("/").pop();
    if (isDesktop) openEditorFile(item.path, { preview: true, artifactTitle: title, artifactSessionId: sessionId });
    else openSheetFile(item.path, { preview: true, artifactSessionId: sessionId });
  }, [isDesktop, openEditorFile, openSheetFile]);

  // The AI asked to show a file it just made (MCP openArtifact). It always joins the
  // stack of the terminal that asked; it only takes over the screen when that terminal
  // is the one on screen — another terminal's file must not shove this one aside.
  useEffect(() => {
    const bus = busRef.current;
    if (!bus) return;
    const onArtifactOpen = ({ path, title, sessionId } = {}) => {
      if (!path) return;
      const item = { path, title: title || path.split("/").pop(), at: Date.now() };
      if (sessionId) pushArtifact(sessionId, item);
      if (!sessionId || sessionId === activeSessionId) openArtifact(sessionId, item);
    };
    bus.on("artifactOpen", onArtifactOpen);
    return () => bus.off("artifactOpen", onArtifactOpen);
  }, [busRef, connected, activeSessionId, pushArtifact, openArtifact]);

  // Lazy per-workspace mount: the FIRST time a workspace becomes active, mark it mounted so its
  // panes' XTerms initialize. Others stay as placeholders until visited — avoids mounting every
  // terminal across all workspaces at once (5+ concurrent joins → main-thread stall).
  useEffect(() => {
    if (!isTerminalView || activeWorkspaceId === undefined) return;
    markWorkspaceMounted(activeWorkspaceId);
  }, [isTerminalView, activeWorkspaceId, markWorkspaceMounted]);

  // Reflect unseen finished-terminal count (or the active session name when idle) in the tab title
  // allSessions: the active pane may belong to any host in the fleet.
  const activeSession = activeSessionId ? allSessions.find((s) => s.id === activeSessionId) : null;
  const activeSessionName = activeSession ? (activeSession.name || t("terminal.defaultName")) : null;
  useEffect(() => { updateTitle(Object.keys(notifications).length, activeSessionName); return () => updateTitle(0); }, [notifications, activeSessionName]);

  // Enable slide animation only after settling in terminal view (avoids slide-through on entry)
  const [swipeAnimEnabled, setSwipeAnimEnabled] = useState(false);
  useEffect(() => {
    if (currentView.type !== "terminal") return setSwipeAnimEnabled(false);
    const id = requestAnimationFrame(() => setSwipeAnimEnabled(true));
    return () => cancelAnimationFrame(id);
  }, [currentView.type]);

  // Slide direction for mobile tab switch ("", "term-slide-left", "term-slide-right")
  const prevActiveRef = useRef(null);
  const [slideClass, setSlideClass] = useState("");
  useEffect(() => {
    const active = currentView.type === "terminal" ? currentView.sessionId : null;
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!swipeAnimEnabled || !active || !prev || active === prev) return setSlideClass("");
    const ids = openedSessions;
    setSlideClass(ids.indexOf(active) > ids.indexOf(prev) ? "term-slide-right" : "term-slide-left");
  }, [currentView, swipeAnimEnabled, openedSessions]);

  // Pop view by updating viewStack and replacing route URL to match target view.
  // Avoids router.back() to prevent WKWebView blank-screen rendering glitch and history races.
  const popView = useCallback(() => {
    // Mobile: close the editor overlay first (it's not in the viewStack) before navigating back
    if (!isDesktop && mobileEditor) {
      if (mobileEditor.artifactSessionId) removeArtifact(mobileEditor.artifactSessionId, mobileEditor.path);
      setMobileEditor(null);
      return;
    }
    const stack = Array.isArray(viewStack) ? viewStack : [];
    const targetView = stack.length > 1 ? stack[stack.length - 2] : { type: "list" };
    storePopView();
    router.replace(viewToPath(targetView));
  }, [router, storePopView, isDesktop, mobileEditor, setMobileEditor, removeArtifact, viewStack]);

  // The terminal header's back means "leave the terminal, go to the session list" — not
  // "undo one step". Stepping one history entry at a time landed on the previous terminal
  // whenever tab switches or deep links had piled entries up, which reads as a tab change.
  // Any other view keeps the ordinary one-step-back.
  const backToSessionList = useCallback(() => {
    if (currentView.type !== "terminal") return popView();
    setViewStack([{ type: "list" }]);
  }, [currentView, popView, setViewStack]);

  // Load sessions + workspaces when the bus connects.
  // Lost-packet retry lives in useSocket (loadedRef-gated, every view).
  useEffect(() => {
    if (bus) loadSessions();
  }, [bus, loadSessions]);

  // Drop openedSessions that no longer exist. Delayed to avoid racing newly-created sessions
  // (server create → loadSessions is async). Validated against the MERGED list —
  // another host's session is as real as the main host's, and sweeping against the
  // main list alone evicted it on every refetch (the remount loop).
  useEffect(() => {
    if (allSessions.length === 0 || openedSessions.length === 0) return;
    const timer = setTimeout(() => {
      const validSessionIds = allSessions.map(s => s.id);
      openedSessions.filter(sid => !validSessionIds.includes(sid)).forEach(sid => removeOpenedSession(sid));
    }, 500);
    return () => clearTimeout(timer);
  }, [allSessions, openedSessions, removeOpenedSession]);

  useTerminalPageViewport({ setKeyboardOpen });

  // Which host a remote-desktop / mobile-mirror view targets (null = the active
  // host). Same components, same flow — only the conn underneath changes.
  const [remoteHead, setRemoteHead] = useState(null);
  const [mobileHead, setMobileHead] = useState(null);
  const remoteConn = connOf(remoteHead || currentFleetKey || null);
  const mobileConn = connOf(mobileHead || currentFleetKey || null);
  const remoteHostRow = fleetHostsMap[remoteHead || currentFleetKey];
  const mobileHostRow = fleetHostsMap[mobileHead || currentFleetKey];

  const handleOpenRemote = useCallback((head = null) => {
    setRemoteHead(head);
    pushView({ type: "remote" });
  }, [pushView]);

  // Desktop keeps the mirror beside the terminal (float / pinned / PiP); a phone
  // has no room to split, so it stays a full-screen view there.
  const handleOpenMobile = useCallback((head = null) => {
    if (!isDesktop) { setMobileHead(head); pushView({ type: "mobile" }); return; }
    if (!mobileOpen) { setMobileHead(head); setMobileOpen(true); return; }
    // Closing must end the agent session, not just hide the panel: the encoder
    // would keep producing frames nobody acknowledges, and the next open would
    // rejoin a stream already crawling behind a backlog of ack timeouts.
    mobileConn.busRef.current?.emit("mobile:stop");
    setMobileSession(null);
    setMobileOpen(false);
    setMobileHead(null);
  }, [isDesktop, mobileOpen, setMobileOpen, setMobileSession, mobileConn, pushView]);

  // Drag the pinned mirror's left edge. Mirrors the editor panel's handle: the
  // panel grows as the pointer moves left, so the delta is inverted.
  const handleMobileResizeStart = useCallback((e) => {
    startWidthDrag(e, { startWidth: mobilePanelWidth, axis: -1, onWidth: setMobilePanelWidth });
  }, [mobilePanelWidth, setMobilePanelWidth]);

  const handleRetryNow = useCallback(() => {
    protocolRef.current?.retryNow();
  }, [protocolRef]);

  // Full page load, not router.push — a lazy chunk fetch can hang forever on a dead network
  const handleDisconnect = useCallback(() => {
    useFleetStore.getState().closeAll();
    resetStore();
    sessionStorage.clear();
    sessionStorage.setItem("9remote_manual_disconnect", "1");
    window.location.replace("/login");
  }, [resetStore]);

  const handleLogoutWithConfirm = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: t("workspace.logoutTitle"),
      message: t("workspace.logoutMessage"),
      onConfirm: handleDisconnect
    });
  }, [handleDisconnect, t]);

  const handleDeleteHost = useCallback((key) => {
    const item = loadKeys().find((k) => headOf(k.key) === key);
    if (item) removeKey(item.id);
    // Removing the host this session lives on ends the session — sync() would
    // keep re-adding it as the live connection's host otherwise. The row's own
    // confirm already asked; no second logout dialog.
    if (key === currentFleetKey) handleDisconnect();
  }, [loadKeys, removeKey, currentFleetKey, handleDisconnect]);

  // Disconnect the session's own host like any fleet row: hop to the next host
  // in add order — a live bus first, then probe-online, then anything else
  // (switchHost health-checks the target before committing, so an unknown
  // status is safe to try; a dead pick leaves this session untouched). Only
  // with NO other host does the link drop for real and the retry screen own
  // the page.
  // Disconnect the ACTIVE host — same meaning as any other row's disconnect, no
  // host-hopping: the workspace connection drops and this page goes to the
  // login/loading gate, while the key stays saved and its intent off.
  const onMainDisconnect = useCallback(() => {
    useFleetStore.getState().disconnectHost(currentFleetKey);
    disconnect();
  }, [currentFleetKey, disconnect]);

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog({ isOpen: false, title: "", message: "", onConfirm: null });
  }, []);

  const handleReorderSession = useCallback((orderedIds) => {
    reorderOpenedSessions(orderedIds);
    reorderSession(orderedIds);
  }, [reorderOpenedSessions, reorderSession]);

  // The three panel descriptors and the pane-width setter are props on the terminal view.
  // A fresh object/closure per render defeats every memo below them, and this component
  // re-renders on each status change, cwd update and notification.
  const handleSetPaneWidth = useCallback((w) => {
    if (activeWorkspaceId) setPaneWidth(activeWorkspaceId, w);
  }, [activeWorkspaceId, setPaneWidth]);

  const rightPanelProps = useMemo(() => ({
    open: rightPanelOpen,
    tabs: rightPanelTabs,
    width: rightPanelWidth,
    onTabChange: setRightPanelTab,
    onResize: setRightPanelWidth,
    onToggle: toggleRightPanel,
    onNewTerminal: createTerminalAt
  }), [rightPanelOpen, rightPanelTabs, rightPanelWidth, setRightPanelTab, setRightPanelWidth, toggleRightPanel, createTerminalAt]);

  const editorPanelProps = useMemo(() => ({
    filePath: editorFilePath,
    previewSeq: editorPreviewSeq,
    artifactTitle,
    width: editorPanelWidth,
    onResize: setEditorPanelWidth,
    onOpen: isDesktop ? openEditorFile : openSheetFile,
    onClose: closeEditorFile,
    // Side panel → full editor route at the file's own workspace root
    onOpenFull: openEditorFull
  }), [editorFilePath, editorPreviewSeq, artifactTitle, editorPanelWidth, setEditorPanelWidth, isDesktop, openEditorFile, openSheetFile, closeEditorFile, openEditorFull]);

  const mobilePanelProps = useMemo(() => ({
    open: mobileOpen,
    mode: mobileMode,
    width: mobilePanelWidth,
    busRef: mobileConn.busRef,
    protocolRef: mobileConn.pmRef,
    connected: mobileHead ? mobileHostRow?.status === "online" : connected,
    onResizeStart: handleMobileResizeStart
  }), [mobileOpen, mobileMode, mobilePanelWidth, mobileConn, mobileHead, mobileHostRow, connected, handleMobileResizeStart]);

  // A missing tunnelUrl is not a missing connection — the DO relay carries RTC,
  // and the transport reports connected when that opens. The STORE bus stays set
  // across a transient disconnect (an in-flight self-update), so only its first
  // absence counts as initializing.
  const isInitializing = !hydrated || !stableBus;

  if (isInitializing) {
    return <ReconnectScreen label={t("workspace.loading")} />;
  }

  const remoteEntry = connected && remoteAvailable ? handleOpenRemote : null;
  const mobileEntry = connected && mobileAvailable ? handleOpenMobile : null;

  return (
    <>
      <AnimatedBackground />
      <Suspense fallback={null}>
        <RouteSyncTracker hydrated={hydrated} apiKey={auth?.apiKey} />
      </Suspense>
      <div className="terminal-container h-[var(--app-height,100vh)] fixed inset-0 overflow-hidden overscroll-none">
        {/* Session list — mobile only. On desktop the sidebar already lists workspaces
            and terminals with more operations, so this would be a weaker copy of it, and
            the bottom of the stack goes straight to the terminal view instead. */}
        {!isDesktop && (
        <div
          className={`absolute inset-0 transition-opacity duration-150 ease-out ${currentView.type === "list"
            ? "opacity-100 z-10"
            : "opacity-0 z-0 pointer-events-none"
            }`}
        >
          <SessionList
            sessions={sessions}
            cwdBySession={cwdBySession}
            connected={connected}
            onSelect={nav.handleSelectSession}
            onCreate={nav.handleCreateSession}
            onDelete={nav.handleDeleteSession}
            onRename={nav.handleRenameSession}
            onResumeAgentSession={nav.handleResumeAgentSession}
            onLogout={handleLogoutWithConfirm}
            onOpenRemote={remoteEntry}
            onOpenMobile={mobileEntry}
            onOpenRemoteHost={handleOpenRemote}
            onOpenMobileHost={handleOpenMobile}
            tunnelUrl={auth?.tunnelUrl}
            apiKey={auth?.apiKey}
            connectionMode={connectionMode}
            isActive={currentView.type === "list"}
            busRef={busRef}
            subscribeToPush={subscribeToPush}
            unsubscribeFromPush={unsubscribeFromPush}
            agentVersion={agentVersion}
            carrier={carrier}
            workspaces={workspaces}
            onAddWorkspace={openFolderPicker}
            homeDir={systemInfo?.homedir}
            onRenameWorkspace={renameWorkspace}
            onDeleteWorkspace={deleteWorkspace}
            onReorderSession={handleReorderSession}
            recentWorkspaces={recentWorkspaces}
            shells={shells}
            onRenameHost={handleRenameHost}
            onDeleteHost={handleDeleteHost}
            onMainDisconnect={onMainDisconnect}
          />
        </div>
        )}

        {/* Terminal view: shared header + multi-pane layout. Always mounted on desktop —
            it is the bottom of the stack there, and its sidebar is the only place to pick
            a workspace. On mobile it waits for a pane to open; the session list is what
            greets an empty machine there. */}
        {(isDesktop || openedSessions.length > 0) && (
          <TerminalWorkspace
            platform={platform}
            agentVersion={agentVersion}
            sessions={allSessions}
            workspaces={allWorkspaces}
            onCreateAnyHost={createSessionOnHost}
            onQuickCreateHostAware={createTerminalFromPrefs}
            onResumeAgentSessionForeign={resumeAgentSessionOnHost}
            activeSessionId={activeSessionId}
            activeSession={activeSession}
            activeWorkspaceId={activeWorkspaceId}
            openedSessions={openedSessions}
            livePanes={livePanes}
            mountedWorkspaces={mountedWorkspaces}
            cwdBySession={cwdBySession}
            isDesktop={isDesktop}
            isTerminalView={isTerminalView}
            slideClass={slideClass}
            shells={shells}
            sidebarCollapsed={sidebarCollapsed}
            sidebarWidth={sidebarWidth}
            setSidebarWidth={setSidebarWidth}
            paneWidth={activeWorkspaceId ? paneWidths[activeWorkspaceId] ?? null : null}
            setPaneWidth={activeWorkspaceId ? handleSetPaneWidth : undefined}
            toggleSidebar={toggleSidebar}
            paneRegistry={paneRegistry}
            bindSwipeTab={bindSwipeTab}
            nav={nav}
            onBack={backToSessionList}
            atStackBottom={isDesktop && currentView.type === "list"}
            onOpenRemote={remoteEntry}
            onOpenMobile={mobileEntry}
            onOpenRemoteHost={handleOpenRemote}
            onOpenMobileHost={handleOpenMobile}
            onOpenFiles={handleOpenFiles}
            onLogout={handleLogoutWithConfirm}
            onDeleteWorkspace={deleteWorkspace}
            onReorderSession={reorderSession}
            onAddWorkspace={openFolderPicker}
            onSetHiddenRepos={setWorkspaceHiddenRepos}
            onOpenSettings={openSlideMenu}
            onRenameHost={handleRenameHost}
            onDeleteHost={handleDeleteHost}
            onMainDisconnect={onMainDisconnect}
            homeDir={systemInfo?.homedir}
            recentWorkspaces={recentWorkspaces}
            onOpenArtifact={openArtifact}
            rightPanel={rightPanelProps}
            editorPanel={editorPanelProps}
            mobilePanel={mobilePanelProps}
            fileBus={fileBus}
            tunnelUrl={auth?.tunnelUrl}
            apiKey={auth?.apiKey}
            connectionMode={connectionMode}
            subscribeToPush={subscribeToPush}
            unsubscribeFromPush={unsubscribeFromPush}
          />
        )}

        {/* Folder picker (desktop): choose the directory a new workspace is rooted at */}
        {folderPicker && (
          <FolderPickerModal
            fileBus={fileBus}
            scope={connScope}
            initialPath={folderPicker.initialPath}
            onSelect={createWorkspaceAt}
            onClose={() => setFolderPicker(null)}
          />
        )}

        {/* Remote Desktop — rides the chosen host's conn (default: active) */}
        {currentView.type === "remote" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out">
            <RemoteDesktop
              onClose={() => { setRemoteHead(null); popView(); }}
              busRef={remoteConn.busRef}
              protocolRef={remoteConn.pmRef}
              connected={remoteHead ? remoteHostRow?.status === "online" : connected}
              carrier={remoteHead ? (remoteHostRow?.carrier || "ws") : carrier}
              hostPlatform={remoteHostRow?.platform || platform}
            />
          </div>
        )}

        {/* Android device mirroring (scrcpy over the transport bus) */}
        {currentView.type === "mobile" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out">
            <MobileMirror
              onClose={() => { setMobileHead(null); popView(); }}
              busRef={mobileConn.busRef}
              protocolRef={mobileConn.pmRef}
              connected={mobileHead ? mobileHostRow?.status === "online" : connected}
            />
          </div>
        )}

        {/* Local sites browser (SW + transport bus, no tunnel needed). Store-only
            overlay (OVERLAY_VIEWS): kept out of the URL/history because in-iframe
            navigation would otherwise pile entries onto the parent history. */}
        {currentView.type === "site" && (
          <BrowserView
            busRef={currentView.hostKey ? connOf(currentView.hostKey).busRef : busRef}
            connected={currentView.hostKey ? fleetHostsMap[currentView.hostKey]?.status === "online" : connected}
            initialPort={currentView.port}
            initialPath={currentView.path}
            onBack={storePopView}
          />
        )}

        {/* Workspace List */}
        {currentView.type === "workspaces" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out">
            <WorkspaceList
              onSelect={handleSelectWorkspace}
              onBrowse={handleBrowseFolder}
              onBack={popView}
              isCodespaces={!!mainHost?.isCodespaces}
              systemInfo={systemInfo}
            />
          </div>
        )}

        {/* Browse Folder (selecting a workspace) */}
        {currentView.type === "browse" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out">
            <FileExplorer
              scope={connScope}
              workspace={currentView.path}
              fileBus={fileBus}
              onBack={popView}
              onSetWorkspace={handleSetWorkspace}
              isBrowsing={true}
            />
          </div>
        )}

        {/* Desktop VSCode-like layout: replaces files/editor/git on a wide screen */}
        {isDesktop && (currentView.type === "files" || currentView.type === "editor" || currentView.type === "git") && (() => {
          // For editor/git, fall back to the most recently pushed files view (last in stack,
          // not first — stale files views linger after workspace switches that only replace the top).
          const filesView = currentView.type === "files"
            ? currentView
            : [...viewStack].reverse().find(v => v.type === "files");
          const ws = filesView?.workspace || currentView.workspace;
          const recent = getRecentWorkspaces(connScope).find(w => w.path === ws);
          // An editor view carrying its own path (side panel's "open full") opens that
          // file outright; otherwise restore the workspace's last open tabs.
          const routeFile = currentView.type === "editor" ? currentView.path : null;
          return (
            <div className="absolute inset-0 z-20 transition-all duration-300 ease-out">
              <FileWorkspaceDesktop
                key={ws}
                workspace={ws}
                fileBus={fileBus}
                onBack={popView}
                onSwitchWorkspace={handleOpenWorkspaceList}
                initialOpenedFiles={routeFile ? [routeFile] : recent?.openedFiles || []}
                initialActiveFile={routeFile || recent?.activeFile || null}
                onOpenedFilesChange={(files, activeFile) => updateOpenedFiles(ws, files, activeFile, connScope)}
                bus={bus}
                connected={connected}
                sessions={sessions}
                onCreateTerminalSession={nav.handleCreateSessionInline}
                onDeleteTerminalSession={nav.handleDeleteSession}
                onRenameTerminalSession={nav.handleRenameSession}
                viewType={currentView.type}
                openFileRef={openFileRef}
              />
            </div>
          );
        })()}

        {/* File Explorer (workspace mode) — mobile only */}
        {!isDesktop && currentView.type === "files" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out">
            <FileExplorer
              scope={connScope}
              workspace={currentView.workspace}
              initialPath={currentView.currentPath}
              fileBus={fileBus}
              onBack={popView}
              onOpenFile={handleOpenFile}
              onOpenGit={handleOpenGit}
              onSwitchWorkspace={handleOpenWorkspaceList}
              onPathChange={(p) => handlePathChange(currentView.workspace, p)}
              hideSwitchWorkspace={currentView.fromTerminal}
            />
          </div>
        )}

        {/* Git Panel — mobile only */}
        {!isDesktop && currentView.type === "git" && (
          <div className="absolute inset-0 z-30 transition-all duration-300 ease-out">
            <GitPanel
              workspace={currentView.workspace}
              fileBus={fileBus}
              onBack={popView}
              onOpenFile={handleOpenFile}
            />
          </div>
        )}

        {/* Mobile editor overlay — above whichever view opened it (files or git), so Back (X)
            returns to that view without a viewStack push. */}
        {!isDesktop && mobileEditor && (
          <div className="absolute inset-0 z-40 transition-all duration-300 ease-out">
            <FileEditor
              filePath={mobileEditor.path}
              line={mobileEditor.line}
              column={mobileEditor.column}
              diffStatus={mobileEditor.diffStatus}
              preview={mobileEditor.preview}
              fileBus={fileBus}
              onBack={() => {
                if (mobileEditor.artifactSessionId) removeArtifact(mobileEditor.artifactSessionId, mobileEditor.path);
                setMobileEditor(null);
              }}
              workspace={mobileEditor.workspace || currentView.workspace}
            />
          </div>
        )}

        {/* Connection Modal — overlay when retrying/failed (suppressed during self-update) */}
        {/* Not admitted yet = the agent has not accepted this device: the
            carrier can be open while the key TAIL is still being proven, and
            the workspace must not show through that window. An in-flight
            self-update of the active host keeps the page usable — its row
            carries the progress instead. */}
        {(!connected || !admitted) && !mainHostUpdating && <ReconnectScreen />}

        {!mainHostUpdating && <ConnectionModal retryStatus={retryStatus} approvalStatus={approvalStatus} connected={connected} suppress={resumeGrace} onLogout={handleDisconnect} onRetryNow={handleRetryNow} />}

        {/* Global Slide Menu — single instance at page level */}
        <SlideMenu />

        {/* Mod+Shift+P file search — reuses the file explorer's palette in files mode */}
        {quickOpen && paletteWorkspace && (
          <CommandPalette
            mode="files"
            workspace={paletteWorkspace}
            fileBus={fileBus}
            onClose={() => setQuickOpen(false)}
            onOpenFile={(path) => openEditorFile(path)}
          />
        )}

        <ShortcutsModal isOpen={shortcutsOpen} onClose={closeShortcutsModal} />

        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          onClose={closeConfirmDialog}
          onConfirm={confirmDialog.onConfirm}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmText={confirmDialog.confirmText}
        />
      </div>
      {/* Child routes are URL markers only (render nothing) */}
      <div hidden><Suspense fallback={null}>{children}</Suspense></div>
      {/* Dev-only termLog overlay (hidden in production) — mobile has no DevTools. */}
      <DevTermLog />
    </>
  );
}
