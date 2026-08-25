"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useSocket } from "@/features/session/hooks/useSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useFileSocket } from "@/features/fileExplorer/hooks/useFileSocket";
import { useClipboardSocket } from "@/features/clipboard/hooks/useClipboardSocket";
import DevTermLog from "@/features/terminal/components/DevTermLog";
import { getRecentWorkspaces, addRecentWorkspace, updateOpenedFiles } from "@/features/fileExplorer/components/WorkspaceList";
import { isDiffPath, parseRepoDiffPath } from "@/features/fileExplorer/constants/fileExplorer";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useNotification } from "@/shared/hooks/useNotification";
import { updateTitle } from "@/shared/utils/titleMarquee";
import { DESKTOP_BREAKPOINT } from "@/features/terminal/constants/terminalConfig";
import { usePwaInstallInit } from "@/features/terminal/hooks/usePwaInstallInit";
import { useSwipeTab } from "@/features/terminal/hooks/useSwipeTab";
import { useTerminalPageViewport } from "@/features/terminal/hooks/useTerminalPageViewport";
import { useWorkspaceFileNav } from "@/features/fileExplorer/hooks/useWorkspaceFileNav";
import { usePaneRegistry } from "@/features/terminal/hooks/usePaneRegistry";
import { useSessionNavigation } from "@/features/terminal/hooks/useSessionNavigation";
import { useAgentUpdate } from "@/features/session/hooks/useAgentUpdate";
import { useGlobalShortcuts } from "@/shared/hooks/useGlobalShortcuts";
import { useShortcutsModalStore } from "@/shared/stores/shortcutsModalStore";
import { useAgentClis } from "@/features/terminal/hooks/useAgentClis";
import { loadTerminalPrefs } from "@/features/terminal/constants/agentCli";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import TerminalWorkspace from "@/features/terminal/components/TerminalWorkspace";
import ReconnectScreen from "@/features/session/components/ReconnectScreen";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";

const SessionList = dynamic(() => import("@/features/session/components/SessionList"), { ssr: false });
const RemoteDesktop = dynamic(() => import("@/features/remote/components/RemoteDesktop"), { ssr: false });
const BrowserView = dynamic(() => import("@/features/browser/components/BrowserView"), { ssr: false });
const WorkspaceList = dynamic(() => import("@/features/fileExplorer/components/WorkspaceList"), { ssr: false });
const FileExplorer = dynamic(() => import("@/features/fileExplorer/components/FileExplorer"), { ssr: false });
const FileEditor = dynamic(() => import("@/features/fileExplorer/components/FileEditor"), { ssr: false });
const GitPanel = dynamic(() => import("@/features/fileExplorer/components/GitPanel"), { ssr: false });
const FileWorkspaceDesktop = dynamic(() => import("@/features/fileExplorer/components/FileWorkspaceDesktop"), { ssr: false });
const FolderPickerModal = dynamic(() => import("@/features/terminal/components/FolderPickerModal"), { ssr: false });
const CommandPalette = dynamic(() => import("@/features/fileExplorer/components/CommandPalette"), { ssr: false });
const ShortcutsModal = dynamic(() => import("@/shared/components/ui/ShortcutsModal"), { ssr: false });
import ConnectionModal from "@/shared/components/ui/ConnectionModal";
import UpdateModal from "@/shared/components/ui/UpdateModal";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import SlideMenu from "@/shared/components/ui/SlideMenu";
import { useI18n } from "@/shared/i18n";
import { useRouteSync } from "@/shared/hooks/useRouteSync";
import { useLastRoute } from "@/shared/hooks/useLastRoute";

// Workspace shell - holds socket/state/views; child routes are URL markers only
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
    artifactTitle
  } = useTerminalStore();

  useEffect(() => {
    setHydrated(true);
  }, []);

  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const { socket, socketRef, protocolRef, connected, connectionMode, transport, sessions, remoteAvailable, codespaceInfo, codespaceDisconnected, codespaceStopping, platform, agentVersion, updateAvailable, canSelfUpdate, triggerUpdate, triggerRestart, retryStatus, approvalStatus, admitted, loadSessions, createSession, deleteSession, renameSession, stopCodespace, workspaces, loadWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, setWorkspaceHiddenRepos, reorderSession } = useSocket();
  const [shells, setShells] = useState([]);

  const { updating, updateMode, resumeGrace, doUpdate, doRestart } = useAgentUpdate({
    connected, triggerUpdate, triggerRestart
  });

  // Ask for confirmation before self-update (restarts connection, ~1 min)
  const handleUpdate = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: t("menu.updateConfirmTitle"),
      message: t("menu.updateConfirmMessage"),
      onConfirm: doUpdate,
    });
  }, [doUpdate, t]);

  const handleRestart = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: t("menu.restartConfirmTitle"),
      message: t("menu.restartConfirmMessage"),
      onConfirm: doRestart,
    });
  }, [doRestart, t]);

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

  const fileSocket = useFileSocket(socketRef, protocolRef);
  useClipboardSocket(socketRef, connected);
  const { subscribeToPush, unsubscribeFromPush, notifications, sessionStatus, clearNotification } = useNotification(socketRef, connected);

  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false, title: "", message: "", onConfirm: null });
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
    sessions, currentView, viewStack, setViewStack, pushView, storePopView,
    activeWorkspaceId, setActiveWorkspaceId, activeSessionId,
    addOpenedSession, removeOpenedSession, touchLivePane,
    createSession, deleteSession, renameSession, clearNotification, socketRef
  });

  const {
    systemInfo, mobileEditor, setMobileEditor, openFileRef,
    handleOpenWorkspaceList, handleOpenFiles, handleSelectWorkspace, handleBrowseFolder,
    handlePathChange, handleOpenFile, handleOpenGit, handleSetWorkspace
  } = useWorkspaceFileNav({ pushView, viewStack, setViewStack, currentView, cwdBySession, isDesktop, fileSocket });


  // Folder picker → create a workspace rooted there, then offer its first terminal.
  const [folderPicker, setFolderPicker] = useState(null); // { initialPath } | null
  const openSlideMenu = useSlideMenuStore((st) => st.open);
  // Re-read after each workspace change; localStorage is client-only so it stays lazy.
  const recentWorkspaces = hydrated ? getRecentWorkspaces() : [];

  const createWorkspaceAt = useCallback((folderPath) => {
    setFolderPicker(null);
    if (!folderPath) return;
    const name = folderPath.split("/").filter(Boolean).pop() || folderPath;
    createWorkspace(name, folderPath, (result) => {
      const ws = result?.workspace || result?.group;
      if (!result?.success || !ws?.id) return;
      addRecentWorkspace(folderPath);
      setActiveWorkspaceId(ws.id);
      nav.handleCreateSession(null, ws.id, null, folderPath);
    });
  }, [createWorkspace, setActiveWorkspaceId, nav]);

  // A path means the user picked a recent folder — skip straight to creating it.
  const openFolderPicker = useCallback((initialPath) => {
    if (initialPath) return createWorkspaceAt(initialPath);
    setFolderPicker({ initialPath: null });
  }, [createWorkspaceAt]);

  // "New terminal here" from the file tree / worktree list — cwd is the clicked folder.
  const createTerminalAt = useCallback((folderPath) => {
    nav.handleCreateSession(null, activeWorkspaceId, null, folderPath);
  }, [nav, activeWorkspaceId]);

  // Mod+Shift chords for the workspace shell. Desktop-only — a phone has no physical
  // keyboard to serve, and the mobile input bar already owns Tab / Ctrl+1-9.
  const agentClis = useAgentClis(socketRef);
  const openShortcutsModal = useShortcutsModalStore((st) => st.open);
  const shortcutsOpen = useShortcutsModalStore((st) => st.isOpen);
  const closeShortcutsModal = useShortcutsModalStore((st) => st.close);
  const [quickOpen, setQuickOpen] = useState(false);
  const paletteWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)?.path
    || sessions.find((s) => s.id === activeSessionId)?.workspacePath
    || null;

  // Replays the new-terminal modal's last choice (agent + skip-permissions + shell) so
  // the chord opens what the user last opened, not a bare shell. An agent that has since
  // left the host's PATH falls back to a plain terminal, same as the modal does.
  const createTerminalFromPrefs = useCallback(() => {
    const { agentId, shellId, yolo } = loadTerminalPrefs();
    const agent = (agentId && agentClis?.find((a) => a.id === agentId)) || null;
    const index = sessions.filter((s) => sessionWorkspaceId(s) === (activeWorkspaceId ?? null)).length + 1;
    const name = agent ? `${agent.short || agent.label} ${index}` : null;
    // At the bottom of the desktop stack the view is "list", where handleCreateSession
    // does not auto-focus — without this the pane would open behind the empty state.
    if (currentView.type !== "terminal") {
      nav.handleQuickCreateSession(agent ? null : shellId, agent, yolo, name, true);
      return;
    }
    nav.handleCreateSession(name, activeWorkspaceId, agent ? null : shellId, null, agent, yolo, true);
  }, [agentClis, sessions, activeWorkspaceId, currentView, nav]);

  // Gated on the terminal view too: remote desktop forwards every keystroke to the host
  // machine, and the full-screen file explorer runs its own chord set — neither may be
  // shadowed by a capture-phase listener sitting above them.
  useGlobalShortcuts({
    sessionPrev: () => nav.switchSession("prev"),
    sessionNext: () => nav.switchSession("next"),
    sessionIndex: (index) => nav.switchToIndex(index),
    newTerminal: createTerminalFromPrefs,
    toggleSidebar,
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
    setMobileEditor({ path, workspace: workspaces.find(w => w.id === activeWorkspaceId)?.path, preview: !!opts.preview });
  }, [workspaces, activeWorkspaceId, setMobileEditor]);

  // The AI asked to show a file it just made (MCP openArtifact). This opens a side
  // panel and nothing else — which terminal is selected is the user's business, so
  // it is left exactly as it was even when another terminal made the request.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const onArtifactOpen = ({ path, title } = {}) => {
      if (!path) return;
      if (isDesktop) openEditorFile(path, { preview: true, artifactTitle: title || path.split("/").pop() });
      else openSheetFile(path, { preview: true });
    };
    socket.on("artifactOpen", onArtifactOpen);
    return () => socket.off("artifactOpen", onArtifactOpen);
  }, [socketRef, connected, isDesktop, openEditorFile, openSheetFile]);

  // Lazy per-workspace mount: the FIRST time a workspace becomes active, mark it mounted so its
  // panes' XTerms initialize. Others stay as placeholders until visited — avoids mounting every
  // terminal across all workspaces at once (5+ concurrent joins → main-thread stall).
  useEffect(() => {
    if (!isTerminalView || activeWorkspaceId === undefined) return;
    markWorkspaceMounted(activeWorkspaceId);
  }, [isTerminalView, activeWorkspaceId, markWorkspaceMounted]);

  // Reflect unseen finished-terminal count (or the active session name when idle) in the tab title
  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : null;
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

  // Sync URL <-> viewStack (deep-link, F5, back/forward)
  useRouteSync(hydrated);

  // Pop view via browser history — history is the single source of truth, the store syncs
  // from the URL via useRouteSync. Fall back to storePopView for deep-links with no prior entry.
  const popView = useCallback(() => {
    // Mobile: close the editor overlay first (it's not in the viewStack) before navigating back
    if (!isDesktop && mobileEditor) { setMobileEditor(null); return; }
    if (typeof history !== "undefined" && history.length > 1) router.back();
    else storePopView();
  }, [router, storePopView, isDesktop, mobileEditor, setMobileEditor]);

  // Load sessions + workspaces when the socket connects.
  // Lost-packet retry lives in useSocket (loadedRef-gated, every view).
  useEffect(() => {
    if (socket) {
      loadSessions();
      loadWorkspaces();
    }
  }, [socket, loadSessions, loadWorkspaces]);

  // Drop openedSessions that no longer exist. Delayed to avoid racing newly-created sessions
  // (server create → loadSessions is async).
  useEffect(() => {
    if (sessions.length === 0 || openedSessions.length === 0) return;
    const timer = setTimeout(() => {
      const validSessionIds = sessions.map(s => s.id);
      openedSessions.filter(sid => !validSessionIds.includes(sid)).forEach(sid => removeOpenedSession(sid));
    }, 500);
    return () => clearTimeout(timer);
  }, [sessions, openedSessions, removeOpenedSession]);

  useTerminalPageViewport({ setKeyboardOpen });

  const handleOpenRemote = useCallback(() => {
    pushView({ type: "remote" });
  }, [pushView]);

  const handleRetryNow = useCallback(() => {
    protocolRef.current?.retryNow();
  }, [protocolRef]);

  // Full page load, not router.push — a lazy chunk fetch can hang forever on a dead network
  const handleDisconnect = useCallback(() => {
    resetStore();
    sessionStorage.clear();
    window.location.replace("/login");
  }, [resetStore]);

  // Redirect to login when the codespace is stopping
  useEffect(() => {
    if (codespaceStopping) handleDisconnect();
  }, [codespaceStopping, handleDisconnect]);

  const handleLogoutWithConfirm = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: t("workspace.logoutTitle"),
      message: t("workspace.logoutMessage"),
      onConfirm: handleDisconnect
    });
  }, [handleDisconnect, t]);

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog({ isOpen: false, title: "", message: "", onConfirm: null });
  }, []);

  const auth = getAuth();
  // Persist the current URL per-agent so switching agents restores the last view
  useLastRoute(auth?.apiKey);
  const isInitializing = !hydrated || (!socket && !auth?.tunnelUrl);

  if (isInitializing) {
    return <ReconnectScreen label={t("workspace.loading")} />;
  }

  const remoteEntry = connected && remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null;

  return (
    <>
      <AnimatedBackground />
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
            onLogout={handleLogoutWithConfirm}
            onOpenRemote={remoteEntry}
            tunnelUrl={auth?.tunnelUrl}
            apiKey={auth?.apiKey}
            connectionMode={connectionMode}
            codespaceInfo={codespaceInfo}
            codespaceDisconnected={codespaceDisconnected}
            onStopCodespace={stopCodespace}
            onUpdate={handleUpdate}
            onRestart={handleRestart}
            isActive={currentView.type === "list"}
            socketRef={socketRef}
            subscribeToPush={subscribeToPush}
            unsubscribeFromPush={unsubscribeFromPush}
            notifications={notifications}
            sessionStatus={sessionStatus}
            clearNotification={clearNotification}
            agentVersion={agentVersion}
            updateAvailable={updateAvailable}
            canSelfUpdate={canSelfUpdate}
            transport={transport}
            workspaces={workspaces}
            onAddWorkspace={openFolderPicker}
            fileSocket={fileSocket}
            homeDir={systemInfo?.homedir}
            onRenameWorkspace={renameWorkspace}
            onDeleteWorkspace={deleteWorkspace}
            recentWorkspaces={recentWorkspaces}
            shells={shells}
          />
        </div>
        )}

        {/* Terminal view: shared header + multi-pane layout. Always mounted on desktop —
            it is the bottom of the stack there, and its sidebar is the only place to pick
            a workspace. On mobile it waits for a pane to open; the session list is what
            greets an empty machine there. */}
        {(isDesktop || openedSessions.length > 0) && (
          <TerminalWorkspace
            socket={socket}
            socketRef={socketRef}
            connected={connected}
            transport={transport}
            platform={platform}
            agentVersion={agentVersion}
            sessions={sessions}
            workspaces={workspaces}
            activeSessionId={activeSessionId}
            activeSession={activeSession}
            activeWorkspaceId={activeWorkspaceId}
            openedSessions={openedSessions}
            livePanes={livePanes}
            mountedWorkspaces={mountedWorkspaces}
            cwdBySession={cwdBySession}
            sessionStatus={sessionStatus}
            notifications={notifications}
            clearNotification={clearNotification}
            isDesktop={isDesktop}
            isTerminalView={isTerminalView}
            slideClass={slideClass}
            shells={shells}
            fileSocket={fileSocket}
            sidebarCollapsed={sidebarCollapsed}
            sidebarWidth={sidebarWidth}
            setSidebarWidth={setSidebarWidth}
            paneWidth={activeWorkspaceId ? paneWidths[activeWorkspaceId] ?? null : null}
            setPaneWidth={activeWorkspaceId ? (w) => setPaneWidth(activeWorkspaceId, w) : undefined}
            toggleSidebar={toggleSidebar}
            paneRegistry={paneRegistry}
            bindSwipeTab={bindSwipeTab}
            nav={nav}
            onBack={popView}
            atStackBottom={isDesktop && currentView.type === "list"}
            onOpenRemote={remoteEntry}
            onOpenFiles={handleOpenFiles}
            onLogout={handleLogoutWithConfirm}
            onStopCodespace={stopCodespace}
            onUpdate={handleUpdate}
            onRestart={handleRestart}
            onDeleteWorkspace={deleteWorkspace}
            onReorderSession={reorderSession}
            onAddWorkspace={openFolderPicker}
            onSetHiddenRepos={setWorkspaceHiddenRepos}
            onOpenSettings={openSlideMenu}
            homeDir={systemInfo?.homedir}
            recentWorkspaces={recentWorkspaces}
            rightPanel={{
              open: rightPanelOpen,
              tabs: rightPanelTabs,
              width: rightPanelWidth,
              onTabChange: setRightPanelTab,
              onResize: setRightPanelWidth,
              onToggle: toggleRightPanel,
              onNewTerminal: createTerminalAt
            }}
            editorPanel={{
              filePath: editorFilePath,
              previewSeq: editorPreviewSeq,
              artifactTitle,
              width: editorPanelWidth,
              onResize: setEditorPanelWidth,
              onOpen: isDesktop ? openEditorFile : openSheetFile,
              onClose: closeEditorFile,
              // Side panel → full editor route at the file's own workspace root
              onOpenFull: openEditorFull
            }}
            codespaceInfo={codespaceInfo}
            tunnelUrl={auth?.tunnelUrl}
            apiKey={auth?.apiKey}
            connectionMode={connectionMode}
            subscribeToPush={subscribeToPush}
            unsubscribeFromPush={unsubscribeFromPush}
            updateAvailable={updateAvailable}
            canSelfUpdate={canSelfUpdate}
          />
        )}

        {/* Folder picker (desktop): choose the directory a new workspace is rooted at */}
        {folderPicker && (
          <FolderPickerModal
            fileSocket={fileSocket}
            initialPath={folderPicker.initialPath}
            onSelect={createWorkspaceAt}
            onClose={() => setFolderPicker(null)}
          />
        )}

        {/* Remote Desktop */}
        {currentView.type === "remote" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out">
            <RemoteDesktop onClose={popView} socketRef={socketRef} protocolRef={protocolRef} connected={connected} connectionMode={connectionMode} transport={transport} hostPlatform={platform} />
          </div>
        )}

        {/* Local sites browser (SW + transport bus, no tunnel needed). Store-only
            overlay (OVERLAY_VIEWS): kept out of the URL/history because in-iframe
            navigation would otherwise pile entries onto the parent history. */}
        {currentView.type === "site" && (
          <BrowserView
            socketRef={socketRef}
            connected={connected}
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
              isCodespaces={codespaceInfo?.isCodespaces}
              systemInfo={systemInfo}
            />
          </div>
        )}

        {/* Browse Folder (selecting a workspace) */}
        {currentView.type === "browse" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out">
            <FileExplorer
              workspace={currentView.path}
              fileSocket={fileSocket}
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
          const recent = getRecentWorkspaces().find(w => w.path === ws);
          // An editor view carrying its own path (side panel's "open full") opens that
          // file outright; otherwise restore the workspace's last open tabs.
          const routeFile = currentView.type === "editor" ? currentView.path : null;
          return (
            <div className="absolute inset-0 z-20 transition-all duration-300 ease-out">
              <FileWorkspaceDesktop
                key={ws}
                workspace={ws}
                fileSocket={fileSocket}
                onBack={popView}
                onSwitchWorkspace={handleOpenWorkspaceList}
                initialOpenedFiles={routeFile ? [routeFile] : recent?.openedFiles || []}
                initialActiveFile={routeFile || recent?.activeFile || null}
                onOpenedFilesChange={(files, activeFile) => updateOpenedFiles(ws, files, activeFile)}
                socket={socket}
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
              workspace={currentView.workspace}
              initialPath={currentView.currentPath}
              fileSocket={fileSocket}
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
              fileSocket={fileSocket}
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
              fileSocket={fileSocket}
              onBack={() => setMobileEditor(null)}
              workspace={mobileEditor.workspace || currentView.workspace}
            />
          </div>
        )}

        {/* Connection Modal — overlay when retrying/failed (suppressed during self-update) */}
        {/* Not admitted yet = the agent has not accepted this device: the
            carrier can be open while the key TAIL is still being proven, and
            the workspace must not show through that window. */}
        {(!connected || !admitted) && <ReconnectScreen />}
        {!updating && <ConnectionModal retryStatus={retryStatus} approvalStatus={approvalStatus} connected={connected} suppress={resumeGrace} onLogout={handleDisconnect} onRetryNow={handleRetryNow} />}

        {/* Update Modal — progress overlay during agent self-update */}
        <UpdateModal open={updating} connected={connected} mode={updateMode} />

        {/* Global Slide Menu — single instance at page level */}
        <SlideMenu />

        {/* Mod+Shift+P file search — reuses the file explorer's palette in files mode */}
        {quickOpen && paletteWorkspace && (
          <CommandPalette
            mode="files"
            workspace={paletteWorkspace}
            fileSocket={fileSocket}
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
        />
      </div>
      {/* Child routes are URL markers only (render nothing) */}
      <div hidden>{children}</div>
      <DevTermLog />
    </>
  );
}
