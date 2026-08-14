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
import { getRecentWorkspaces, updateOpenedFiles } from "@/features/fileExplorer/components/WorkspaceList";
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
import TerminalWorkspace from "@/features/terminal/components/TerminalWorkspace";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";

const SessionList = dynamic(() => import("@/features/session/components/SessionList"), { ssr: false });
const RemoteDesktop = dynamic(() => import("@/features/remote/components/RemoteDesktop"), { ssr: false });
const WorkspaceList = dynamic(() => import("@/features/fileExplorer/components/WorkspaceList"), { ssr: false });
const FileExplorer = dynamic(() => import("@/features/fileExplorer/components/FileExplorer"), { ssr: false });
const FileEditor = dynamic(() => import("@/features/fileExplorer/components/FileEditor"), { ssr: false });
const GitPanel = dynamic(() => import("@/features/fileExplorer/components/GitPanel"), { ssr: false });
const FileWorkspaceDesktop = dynamic(() => import("@/features/fileExplorer/components/FileWorkspaceDesktop"), { ssr: false });
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
    activeGroupId,
    setActiveGroupId,
    livePanes,
    touchLivePane,
    mountedGroups,
    markGroupMounted,
    reset: resetStore,
    cwdBySession,
    sidebarCollapsed,
    toggleSidebar,
    sidebarWidth,
    setSidebarWidth
  } = useTerminalStore();

  useEffect(() => {
    setHydrated(true);
  }, []);

  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const { socket, socketRef, protocolRef, connected, connectionMode, transport, sessions, remoteAvailable, codespaceInfo, codespaceDisconnected, codespaceStopping, platform, agentVersion, updateAvailable, canSelfUpdate, triggerUpdate, triggerRestart, retryStatus, approvalStatus, loadSessions, createSession, deleteSession, renameSession, stopCodespace, groups, loadGroups, createGroup, renameGroup, deleteGroup, moveSession, reorderSession } = useSocket();
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
  const isTerminalView = currentView?.type === "terminal";
  const activeSessionId = isTerminalView ? currentView?.sessionId : null;

  const paneRegistry = usePaneRegistry({ isDesktop, isTerminalView, activeSessionId, currentView, openedSessions });

  const nav = useSessionNavigation({
    sessions, currentView, viewStack, setViewStack, pushView, storePopView,
    activeGroupId, setActiveGroupId, activeSessionId,
    addOpenedSession, removeOpenedSession, touchLivePane,
    createSession, deleteSession, renameSession, clearNotification
  });

  const {
    systemInfo, mobileEditor, setMobileEditor, openFileRef,
    handleOpenWorkspaceList, handleOpenFiles, handleSelectWorkspace, handleBrowseFolder,
    handlePathChange, handleOpenFile, handleOpenGit, handleSetWorkspace
  } = useWorkspaceFileNav({ pushView, viewStack, setViewStack, currentView, cwdBySession, isDesktop, fileSocket });


  // Lazy per-group mount: the FIRST time a group becomes active, mark it mounted so its panes'
  // XTerms initialize. Other groups stay as placeholders until visited — avoids mounting every
  // terminal across all groups at once (5+ concurrent joins → main-thread stall).
  useEffect(() => {
    if (!isTerminalView || activeGroupId === undefined) return;
    markGroupMounted(activeGroupId);
  }, [isTerminalView, activeGroupId, markGroupMounted]);

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

  // Load sessions + groups when the socket connects
  useEffect(() => {
    if (socket) {
      loadSessions();
      loadGroups();
    }
  }, [socket, loadSessions, loadGroups]);

  // Retry once after 1s if still empty in terminal view (guards a rare connect race where the
  // terminal:ready reply arrives too late)
  useEffect(() => {
    if (currentView.type !== "terminal") return;
    if (sessions.length || groups.length) return;
    const timer = setTimeout(() => { loadSessions(); loadGroups(); }, 1000);
    return () => clearTimeout(timer);
  }, [currentView.type, sessions.length, groups.length, loadSessions, loadGroups]);

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
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="text-text-muted">{t("workspace.loading")}</div>
      </div>
    );
  }

  const remoteEntry = connected && remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null;

  return (
    <>
      <AnimatedBackground />
      <div className="terminal-container h-[var(--app-height,100vh)] fixed inset-0 overflow-hidden overscroll-none">
        {/* Session List */}
        <div
          className={`absolute inset-0 transition-all duration-150 ease-out ${currentView.type === "list"
            ? "translate-x-0 opacity-100 z-10"
            : "-translate-x-full opacity-0 z-0 pointer-events-none"
            }`}
        >
          <SessionList
            sessions={sessions}
            connected={connected}
            onSelect={nav.handleSelectSession}
            onCreate={nav.handleCreateSession}
            onDelete={nav.handleDeleteSession}
            onRename={nav.handleRenameSession}
            onLogout={handleLogoutWithConfirm}
            onOpenRemote={remoteEntry}
            onOpenFiles={handleOpenFiles}
            tunnelUrl={auth?.tunnelUrl}
            apiKey={auth?.apiKey}
            connectionMode={connectionMode}
            codespaceInfo={codespaceInfo}
            codespaceDisconnected={codespaceDisconnected}
            onStopCodespace={stopCodespace}
            onUpdate={handleUpdate}
            onRestart={handleRestart}
            retryStatus={retryStatus}
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
            groups={groups}
            onCreateGroup={createGroup}
            onRenameGroup={renameGroup}
            onDeleteGroup={deleteGroup}
            onMoveSession={moveSession}
            onReorderSession={reorderSession}
            shells={shells}
          />
        </div>

        {/* Terminal view: shared header + multi-pane layout */}
        {openedSessions.length > 0 && (
          <TerminalWorkspace
            socket={socket}
            socketRef={socketRef}
            connected={connected}
            transport={transport}
            platform={platform}
            agentVersion={agentVersion}
            sessions={sessions}
            groups={groups}
            activeSessionId={activeSessionId}
            activeSession={activeSession}
            activeGroupId={activeGroupId}
            openedSessions={openedSessions}
            livePanes={livePanes}
            mountedGroups={mountedGroups}
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
            toggleSidebar={toggleSidebar}
            paneRegistry={paneRegistry}
            bindSwipeTab={bindSwipeTab}
            nav={nav}
            onBack={popView}
            onOpenRemote={remoteEntry}
            onOpenFiles={handleOpenFiles}
            onLogout={handleLogoutWithConfirm}
            onStopCodespace={stopCodespace}
            onUpdate={handleUpdate}
            onRestart={handleRestart}
            onCreateGroup={createGroup}
            onDeleteGroup={deleteGroup}
            onMoveSession={moveSession}
            onReorderSession={reorderSession}
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

        {/* Remote Desktop */}
        {currentView.type === "remote" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-right">
            <RemoteDesktop onClose={popView} socketRef={socketRef} protocolRef={protocolRef} connected={connected} connectionMode={connectionMode} transport={transport} hostPlatform={platform} />
          </div>
        )}

        {/* Workspace List */}
        {currentView.type === "workspaces" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-bottom">
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
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-bottom">
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
          // not first — stale files views linger after group switches that only replace the top).
          const filesView = currentView.type === "files"
            ? currentView
            : [...viewStack].reverse().find(v => v.type === "files");
          const ws = filesView?.workspace || currentView.workspace;
          const recent = getRecentWorkspaces().find(w => w.path === ws);
          return (
            <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-bottom">
              <FileWorkspaceDesktop
                workspace={ws}
                fileSocket={fileSocket}
                onBack={popView}
                onSwitchWorkspace={handleOpenWorkspaceList}
                initialOpenedFiles={recent?.openedFiles || []}
                initialActiveFile={recent?.activeFile || null}
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
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-bottom">
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
          <div className="absolute inset-0 z-30 transition-all duration-300 ease-out animate-in slide-in-from-right">
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
          <div className="absolute inset-0 z-40 transition-all duration-300 ease-out animate-in slide-in-from-right">
            <FileEditor
              filePath={mobileEditor.path}
              line={mobileEditor.line}
              column={mobileEditor.column}
              fileSocket={fileSocket}
              onBack={() => setMobileEditor(null)}
              workspace={mobileEditor.workspace || currentView.workspace}
            />
          </div>
        )}

        {/* Connection Modal — overlay when retrying/failed (suppressed during self-update) */}
        {!updating && <ConnectionModal retryStatus={retryStatus} approvalStatus={approvalStatus} connected={connected} suppress={resumeGrace} onLogout={handleDisconnect} onRetryNow={handleRetryNow} />}

        {/* Update Modal — progress overlay during agent self-update */}
        <UpdateModal open={updating} connected={connected} mode={updateMode} />

        {/* Global Slide Menu — single instance at page level */}
        <SlideMenu />

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
