"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useSocket } from "@/features/session/hooks/useSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useFileSocket } from "@/features/fileExplorer/hooks/useFileSocket";
import { addRecentWorkspace, getRecentWorkspaces, updateRecentWorkspacePath } from "@/features/fileExplorer/components/WorkspaceList";
import MobileBackgroundImage from "@/shared/components/ui/MobileBackground";
import { useNotification } from "@/shared/hooks/useNotification";
import { DESKTOP_BREAKPOINT, PANE_MIN_WIDTH } from "@/features/terminal/constants/terminalConfig";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";

const TerminalHeader = dynamic(() => import("@/features/terminal/components/TerminalHeader"), { ssr: false });
const TerminalPane = dynamic(() => import("@/features/terminal/components/TerminalPane"), { ssr: false });
const SessionList = dynamic(() => import("@/features/session/components/SessionList"), { ssr: false });
const RemoteDesktop = dynamic(() => import("@/features/remote/components/RemoteDesktop"), { ssr: false });
const WorkspaceList = dynamic(() => import("@/features/fileExplorer/components/WorkspaceList"), { ssr: false });
const FileExplorer = dynamic(() => import("@/features/fileExplorer/components/FileExplorer"), { ssr: false });
const FileEditor = dynamic(() => import("@/features/fileExplorer/components/FileEditor"), { ssr: false });
const GitPanel = dynamic(() => import("@/features/fileExplorer/components/GitPanel"), { ssr: false });
import ConnectionModal from "@/shared/components/ui/ConnectionModal";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import SlideMenu from "@/shared/components/ui/SlideMenu";
import { useI18n } from "@/shared/i18n";

// Main workspace page - contains sessions, terminal, file explorer, remote desktop, etc.
export default function WorkspacePage() {
  const { t } = useI18n();
  // Hydration state for Zustand
  const [hydrated, setHydrated] = useState(false);

  // UI state from Zustand store (persisted to sessionStorage)
  const {
    viewStack,
    openedSessions,
    pushView,
    popView: storePopView,
    setViewStack,
    addOpenedSession,
    removeOpenedSession,
    reset: resetStore
  } = useTerminalStore();

  // Hydrate Zustand on mount
  useEffect(() => {
    setHydrated(true);
  }, []);

  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("terminal_theme") || "default";
    }
    return "default";
  });
  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const { socket, socketRef, connected, connectionMode, sessions, remoteAvailable, codespaceInfo, codespaceDisconnected, codespaceStopping, platform, agentVersion, retryStatus, approvalStatus, loadSessions, createSession, deleteSession, renameSession, stopCodespace } = useSocket();
  const fileSocket = useFileSocket(socketRef);
  const { subscribeToPush, unsubscribeFromPush, notifications, clearNotification } = useNotification(socketRef, connected);
  const [systemInfo, setSystemInfo] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false, title: "", message: "", onConfirm: null });
  const setKeyboardOpen = useUIStore((state) => state.setKeyboardOpen); // Selector - only subscribe to function

  // Desktop split-view detection
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= DESKTOP_BREAKPOINT : false
  );
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Registry of per-pane APIs (focus, doResize) for MobileKeyboard callbacks
  const paneApisRef = useRef({});
  const registerPaneApi = useCallback((sessionId, api) => {
    if (api) paneApisRef.current[sessionId] = api;
    else delete paneApisRef.current[sessionId];
  }, []);

  // Registry of pane DOM elements for auto-scroll into view
  const paneElementsRef = useRef({});
  const registerPaneElement = useCallback((sessionId, el) => {
    if (el) paneElementsRef.current[sessionId] = el;
    else delete paneElementsRef.current[sessionId];
  }, []);

  // Save theme to localStorage when changed
  const handleThemeChange = useCallback((newTheme) => {
    setTheme(newTheme);
    if (typeof window !== "undefined") {
      localStorage.setItem("terminal_theme", newTheme);
    }
  }, []);

  // Current view is top of stack
  const currentView = viewStack[viewStack.length - 1];

  // Pop view and reload sessions - keep terminals alive across back/forth
  const popView = useCallback(() => {
    storePopView();
    loadSessions();
  }, [storePopView, loadSessions]);

  // Load sessions when socket connects
  useEffect(() => {
    if (socket) {
      loadSessions();
    }
  }, [socket, loadSessions]);

  // Cleanup openedSessions - remove sessions that no longer exist
  // Delay to avoid race with newly-created sessions (server create → loadSessions is async)
  useEffect(() => {
    if (sessions.length === 0 || openedSessions.length === 0) return;
    const timer = setTimeout(() => {
      const validSessionIds = sessions.map(s => s.id);
      const invalidSessions = openedSessions.filter(sid => !validSessionIds.includes(sid));
      if (invalidSessions.length > 0) {
        invalidSessions.forEach(sid => removeOpenedSession(sid));
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [sessions, openedSessions, removeOpenedSession]);

  // VisualViewport height - handle mobile keyboard
  useEffect(() => {
    let lastKeyboardState = false; // Track keyboard state to prevent unnecessary updates

    const updateAppHeight = () => {
      const vv = window.visualViewport;
      const vvHeight = vv?.height || window.innerHeight;

      const offsetTop = vv?.offsetTop || 0;
      const isKeyboardOpen = vvHeight < window.innerHeight - 100;

      // Only update if keyboard state actually changed
      if (lastKeyboardState !== isKeyboardOpen) {
        lastKeyboardState = isKeyboardOpen;
        setKeyboardOpen(isKeyboardOpen);
      }

      // Use innerHeight when keyboard closed (visualViewport may stay short on iOS).
      const vh = isKeyboardOpen ? vvHeight : window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${vh}px`);

      // iOS 26 Safari bug (FB20191055): after dismissing the keyboard,
      // visualViewport.offsetTop can stay > 0 (~24px), pushing position:fixed
      // elements down so the top of the app is clipped. Compensate by translating
      // the <html> element up by offsetTop when keyboard is closed.
      if (!isKeyboardOpen && offsetTop > 0) {
        document.documentElement.style.transform = `translateY(${-offsetTop}px)`;
      } else {
        document.documentElement.style.transform = "";
      }
      window.scrollTo(0, 0);
    };

    document.documentElement.classList.add("terminal-page");

    const preventScroll = (e) => {
      // Allow scroll in xterm, codemirror, file explorer, git panel, modals
      if (
        e.target.closest(".xterm-viewport") ||
        e.target.closest(".xterm-screen") ||
        e.target.closest(".cm-scroller") ||
        e.target.closest(".cm-content") ||
        e.target.closest(".overflow-auto") ||
        e.target.closest(".modal-scrollable")
      ) return;
      e.preventDefault();
    };

    document.addEventListener("touchmove", preventScroll, { passive: false });

    // Prevent iOS auto-scroll pushing fixed layout when focusing inputs
    const handleFocusIn = (e) => {
      if (e.target.matches("input, textarea")) {
        requestAnimationFrame(() => window.scrollTo(0, 0));
      }
    };
    document.addEventListener("focusin", handleFocusIn);

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => setTimeout(updateAppHeight, 0));
      window.visualViewport.addEventListener("scroll", () => setTimeout(updateAppHeight, 0));
    }
    window.addEventListener("resize", updateAppHeight);
    updateAppHeight();

    return () => {
      document.documentElement.classList.remove("terminal-page"); 
      document.documentElement.style.transform = "";
      document.removeEventListener("touchmove", preventScroll);
      document.removeEventListener("focusin", handleFocusIn);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", updateAppHeight);
        window.visualViewport.removeEventListener("scroll", updateAppHeight);
      }
      window.removeEventListener("resize", updateAppHeight);
    };
  }, []);

  const handleCreateSession = useCallback((name) => {
    createSession(name, (result) => {
      if (!result.success) {
        alert(t("workspace.failedCreateSession", { error: result.error }));
      } else if (result.sessionId) {
        addOpenedSession(result.sessionId);
      }
    });
  }, [createSession, addOpenedSession, t]);

  // Smooth-scroll focused pane to center of viewport (desktop split-view only)
  useEffect(() => {
    if (!isDesktop || currentView.type !== "terminal") return;
    const el = paneElementsRef.current[currentView.sessionId];
    if (!el) return;
    // Defer to next frame so layout is stable (e.g. after mount)
    const id = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    });
    return () => cancelAnimationFrame(id);
  }, [isDesktop, currentView, openedSessions]);

  // Entering terminal view: auto-open ALL sessions, set active = selected one
  const handleSelectSession = useCallback((sessionId) => {
    sessions.forEach(s => addOpenedSession(s.id));
    addOpenedSession(sessionId);

    if (currentView.type === "terminal") {
      const newStack = [...viewStack];
      newStack[newStack.length - 1] = { type: "terminal", sessionId };
      setViewStack(newStack);
    } else {
      pushView({ type: "terminal", sessionId });
    }
  }, [sessions, addOpenedSession, currentView, viewStack, setViewStack, pushView]);

  // Quick-create from terminal header "+" button - auto-switch focus to new session
  const handleQuickCreateSession = useCallback(() => {
    const name = `${t("terminal.defaultName")} ${sessions.length + 1}`;
    createSession(name, (result) => {
      if (!result.success) {
        alert(t("workspace.failedCreateSession", { error: result.error }));
        return;
      }
      if (result.sessionId) {
        // Reuse handleSelectSession: adds to openedSessions + switches active tab
        handleSelectSession(result.sessionId);
      }
    });
  }, [sessions, createSession, handleSelectSession, t]);

  const handleDeleteSession = useCallback((sessionId) => {
    deleteSession(sessionId, () => {
      removeOpenedSession(sessionId);
    });
  }, [deleteSession, removeOpenedSession]);

  const handleRenameSession = useCallback((sessionId, newName) => {
    renameSession(sessionId, newName, (result) => {
      if (!result.success) {
        alert(t("workspace.failedRenameSession", { error: result.error }));
      }
    });
  }, [renameSession, t]);

  const handleOpenRemote = useCallback(() => {
    pushView({ type: "remote" });
  }, [pushView]);

  const handleOpenWorkspaceList = useCallback(async () => {
    // Fetch system info when opening workspaces view
    if (!systemInfo) {
      const info = await fileSocket.getSystemInfo();
      if (info.success) {
        setSystemInfo(info);
      }
    }
    pushView({ type: "workspaces" });
  }, [pushView, fileSocket, systemInfo]);

  const handleOpenFiles = useCallback(async () => {
    // Auto-open most recent workspace (restore last visited folder); else show list
    const recent = getRecentWorkspaces();
    if (recent.length > 0) {
      const last = recent[0];
      pushView({ type: "files", workspace: last.path, currentPath: last.lastPath || last.path });
      return;
    }
    handleOpenWorkspaceList();
  }, [pushView, handleOpenWorkspaceList]);

  const handleSelectWorkspace = useCallback((workspacePath) => {
    addRecentWorkspace(workspacePath);
    // Replace any existing workspaces/files views in stack with fresh files view
    // so Back doesn't revisit old workspace or the selector
    const cleaned = viewStack.filter(v => v.type !== "workspaces" && v.type !== "files");
    setViewStack([...cleaned, { type: "files", workspace: workspacePath }]);
  }, [viewStack, setViewStack]);

  const handleBrowseFolder = useCallback((startPath) => {
    pushView({ type: "browse", path: startPath });
  }, [pushView]);

  const handlePathChange = useCallback((workspacePath, currentPath) => {
    // Persist last visited folder per workspace so next open restores it
    updateRecentWorkspacePath(workspacePath, currentPath);
  }, []);

  const handleOpenFile = useCallback((filePath, folderPath) => {
    // Save current folder path so we can restore it when back from editor
    if (folderPath) {
      // Update files view with current folder path before opening editor
      const filesViewIndex = viewStack.findIndex(v => v.type === "files");
      if (filesViewIndex !== -1) {
        const newStack = [...viewStack];
        newStack[filesViewIndex] = { ...newStack[filesViewIndex], currentPath: folderPath };
        setViewStack(newStack);
      }
    }
    pushView({ type: "editor", path: filePath });
  }, [pushView, viewStack, setViewStack]);

  const handleOpenGit = useCallback(() => {
    const filesView = viewStack.find(v => v.type === "files");
    if (filesView?.workspace) {
      pushView({ type: "git", workspace: filesView.workspace });
    }
  }, [pushView, viewStack]);

  const handleSetWorkspace = useCallback((workspacePath) => {
    // Replace browse/workspaces/files views with fresh files view
    // so Back doesn't revisit browse selector or old workspace
    addRecentWorkspace(workspacePath);
    const cleaned = viewStack.filter(v => v.type !== "browse" && v.type !== "workspaces" && v.type !== "files");
    setViewStack([...cleaned, { type: "files", workspace: workspacePath }]);
  }, [viewStack, setViewStack]);

  const handleOpenSite = useCallback((site) => {
    // Open local site in new tab via proxy
    if (site?.port) {
      const auth = getAuth();
      const proxyUrl = `${auth?.tunnelUrl}/proxy/${site.port}`;
      window.open(proxyUrl, "_blank");
    }
  }, [getAuth]);

  const handleDisconnect = useCallback(() => {
    resetStore();
    sessionStorage.clear();
    router.push("/login");
  }, [resetStore, router]);

  // Redirect to login when codespace is stopping
  useEffect(() => {
    if (codespaceStopping) {
      handleDisconnect();
    }
  }, [codespaceStopping, handleDisconnect]);

  // Logout with confirmation dialog
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

  // Only show loading on initial mount or hydration
  const auth = getAuth();
  const isInitializing = !hydrated || (!socket && !auth?.tunnelUrl);

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-dark-700 flex items-center justify-center">
        <div className="text-dark-100">{t("workspace.loading")}</div>
      </div>
    );
  }

  return (
    <>
      {/* <MobileBackgroundImage /> */}
      <div className="terminal-container h-[var(--app-height,100vh)] fixed inset-0 overflow-hidden overscroll-none">
        {/* Session List */}
        <div
          className={`absolute inset-0 transition-all duration-300 ease-out ${currentView.type === "list"
            ? "translate-x-0 opacity-100 z-10"
            : "-translate-x-full opacity-0 z-0 pointer-events-none"
            }`}
        >
          <SessionList
            sessions={sessions}
            connected={connected}
            onSelect={handleSelectSession}
            onCreate={handleCreateSession}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            onLogout={handleLogoutWithConfirm}
            onOpenRemote={connected && remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null}
            onOpenFiles={handleOpenFiles}
            tunnelUrl={auth?.tunnelUrl}
            apiKey={auth?.apiKey}
            connectionMode={connectionMode}
            codespaceInfo={codespaceInfo}
            codespaceDisconnected={codespaceDisconnected}
            onStopCodespace={stopCodespace}
            retryStatus={retryStatus}
            isActive={currentView.type === "list"}
            socketRef={socketRef}
            subscribeToPush={subscribeToPush}
            unsubscribeFromPush={unsubscribeFromPush}
            notifications={notifications}
            clearNotification={clearNotification}
            agentVersion={agentVersion}
          />
        </div>

        {/* Terminal view: shared header + multi-pane layout */}
        {openedSessions.length > 0 && (() => {
          const isTerminalView = currentView.type === "terminal";
          const activeSessionId = isTerminalView ? currentView.sessionId : null;
          return (
            <div
              className={`absolute inset-0 transition-all duration-300 ease-out flex flex-col ${isTerminalView ? "translate-x-0 opacity-100 z-10" : "translate-x-full opacity-0 z-0 pointer-events-none"
                }`}
            >
              <TerminalHeader
                sessions={sessions}
                activeSessionId={activeSessionId}
                isActive={isTerminalView}
                connected={connected}
                notifications={notifications}
                onSwitchSession={handleSelectSession}
                onCreateSession={handleQuickCreateSession}
                onBack={popView}
                onOpenRemote={connected && remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null}
                onOpenFiles={handleOpenFiles}
                onLogout={handleLogoutWithConfirm}
                onStopCodespace={stopCodespace}
                onThemeChange={handleThemeChange}
                theme={theme}
                codespaceInfo={codespaceInfo}
                tunnelUrl={auth?.tunnelUrl}
                apiKey={auth?.apiKey}
                connectionMode={connectionMode}
                subscribeToPush={subscribeToPush}
                unsubscribeFromPush={unsubscribeFromPush}
                agentVersion={agentVersion}
                socketRef={socketRef}
              />

              {/* Panes container: desktop = horizontal scroll split, mobile = overlay active pane */}
              <div className={`flex-1 min-h-0 ${isDesktop ? "flex flex-row overflow-x-auto overflow-y-hidden divide-x divide-dark-400" : "relative"}`}>
                {openedSessions.map((sessionId) => {
                  const isFocused = sessionId === activeSessionId;
                  const isVisible = isDesktop || isFocused;
                  return (
                    <div
                      key={sessionId}
                      ref={(el) => registerPaneElement(sessionId, el)}
                      className={
                        isDesktop
                          ? "flex-1 h-full"
                          : `absolute inset-0 ${isFocused ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"}`
                      }
                      style={isDesktop ? { minWidth: `${PANE_MIN_WIDTH}px` } : undefined}
                    >
                      <TerminalPane
                        socket={socket}
                        connected={connected}
                        sessionId={sessionId}
                        isVisible={isVisible}
                        isFocused={isFocused}
                        theme={theme}
                        onActivate={handleSelectSession}
                        onRegisterApi={registerPaneApi}
                        showFocusBorder={isDesktop && openedSessions.length > 1}
                        notifications={notifications}
                        clearNotification={clearNotification}
                      />
                    </div>
                  );
                })}
              </div>

              {/* Shared MobileKeyboard - routes to focused pane */}
              {activeSessionId && (
                <MobileKeyboard
                  socket={socket}
                  sessionId={activeSessionId}
                  onExpandChange={() => paneApisRef.current[activeSessionId]?.doResize?.()}
                  onRefocus={() => paneApisRef.current[activeSessionId]?.focus?.()}
                  platform={platform}
                />
              )}
            </div>
          );
        })()}

        {/* Remote Desktop - conditional render */}
        {currentView.type === "remote" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-right">
            <RemoteDesktop onClose={popView} socketRef={socketRef} connected={connected} connectionMode={connectionMode} />
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

        {/* Browse Folder (selecting workspace) */}
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

        {/* File Explorer (workspace mode) */}
        {currentView.type === "files" && (
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
            />
          </div>
        )}

        {/* File Editor */}
        {currentView.type === "editor" && (
          <div className="absolute inset-0 z-30 transition-all duration-300 ease-out animate-in slide-in-from-right">
            <FileEditor
              filePath={currentView.path}
              line={currentView.line}
              column={currentView.column}
              fileSocket={fileSocket}
              onBack={popView}
              workspace={viewStack.find(v => v.type === "files")?.workspace}
            />
          </div>
        )}

        {/* Git Panel */}
        {currentView.type === "git" && (
          <div className="absolute inset-0 z-30 transition-all duration-300 ease-out animate-in slide-in-from-right">
            <GitPanel
              workspace={currentView.workspace}
              fileSocket={fileSocket}
              onBack={popView}
              onOpenFile={handleOpenFile}
            />
          </div>
        )}

        {/* Connection Modal - overlay when retrying/failed */}
        <ConnectionModal retryStatus={retryStatus} approvalStatus={approvalStatus} onLogout={handleDisconnect} />

        {/* Global Slide Menu - single instance at page level */}
        <SlideMenu />

        {/* Confirm Dialog - page level for logout confirmation */}
        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          onClose={closeConfirmDialog}
          onConfirm={confirmDialog.onConfirm}
          title={confirmDialog.title}
          message={confirmDialog.message}
        />
      </div>
    </>
  );
}
