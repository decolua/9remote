"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useSocket } from "@/features/session/hooks/useSocket";
import { useOpenClawSocket } from "@/features/openclaw/hooks/useOpenClawSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useFileSocket } from "@/features/fileExplorer/hooks/useFileSocket";
import { addRecentWorkspace } from "@/features/fileExplorer/components/WorkspaceList";
import MobileBackgroundImage from "@/shared/components/ui/MobileBackground";
import { useNotification } from "@/shared/hooks/useNotification";

const Terminal = dynamic(() => import("@/features/terminal/components/Terminal"), { ssr: false });
const SessionList = dynamic(() => import("@/features/session/components/SessionList"), { ssr: false });
const RemoteDesktop = dynamic(() => import("@/features/remote/components/RemoteDesktop"), { ssr: false });
const WorkspaceList = dynamic(() => import("@/features/fileExplorer/components/WorkspaceList"), { ssr: false });
const FileExplorer = dynamic(() => import("@/features/fileExplorer/components/FileExplorer"), { ssr: false });
const FileEditor = dynamic(() => import("@/features/fileExplorer/components/FileEditor"), { ssr: false });
const GitPanel = dynamic(() => import("@/features/fileExplorer/components/GitPanel"), { ssr: false });
const OpenClawChat = dynamic(() => import("@/features/openclaw/components/OpenClawChat"), { ssr: false });
import ConnectionModal from "@/shared/components/ui/ConnectionModal";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import SlideMenu from "@/shared/components/ui/SlideMenu";

// Main workspace page - contains sessions, terminal, file explorer, remote desktop, etc.
export default function WorkspacePage() {
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
    clearOpenedSessions,
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
  const { socket, socketRef, connected, connectionMode, sessions, remoteAvailable, codespaceInfo, codespaceDisconnected, codespaceStopping, platform, retryStatus, loadSessions, createSession, deleteSession, renameSession, stopCodespace } = useSocket();
  const { socketRef: openclawSocketRef, connected: openclawConnected } = useOpenClawSocket();
  const fileSocket = useFileSocket(socketRef);
  const { subscribeToPush, unsubscribeFromPush, notifications, clearNotification } = useNotification(socketRef, connected);
  const [systemInfo, setSystemInfo] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false, title: "", message: "", onConfirm: null });
  const setKeyboardOpen = useUIStore((state) => state.setKeyboardOpen); // Selector - only subscribe to function

  // Save theme to localStorage when changed
  const handleThemeChange = useCallback((newTheme) => {
    setTheme(newTheme);
    if (typeof window !== "undefined") {
      localStorage.setItem("terminal_theme", newTheme);
    }
  }, []);

  // Current view is top of stack
  const currentView = viewStack[viewStack.length - 1];

  // Pop view and reload sessions
  const popView = useCallback(() => {
    // Clear all opened sessions when going back from terminal to list (unmount terminals)
    if (currentView.type === "terminal") {
      clearOpenedSessions();
    }
    storePopView();
    loadSessions();
  }, [currentView, clearOpenedSessions, storePopView, loadSessions]);

  // Load sessions when socket connects
  useEffect(() => {
    if (socket) {
      loadSessions();
    }
  }, [socket, loadSessions]);

  // Cleanup openedSessions - remove sessions that no longer exist
  useEffect(() => {
    if (sessions.length > 0 && openedSessions.length > 0) {
      const validSessionIds = sessions.map(s => s.id);
      const invalidSessions = openedSessions.filter(sid => !validSessionIds.includes(sid));
      
      if (invalidSessions.length > 0) {
        console.log("Cleaning up invalid sessions:", invalidSessions);
        invalidSessions.forEach(sid => removeOpenedSession(sid));
      }
    }
  }, [sessions, openedSessions, removeOpenedSession]);

  // VisualViewport height - handle mobile keyboard
  useEffect(() => {
    let lastKeyboardState = false; // Track keyboard state to prevent unnecessary updates
    
    const updateAppHeight = () => {
      const vh = window.visualViewport?.height || window.innerHeight;
      const isKeyboardOpen = vh < window.innerHeight - 100;
      
      // Only update if keyboard state actually changed
      if (lastKeyboardState !== isKeyboardOpen) {
        lastKeyboardState = isKeyboardOpen;
        setKeyboardOpen(isKeyboardOpen);
      }
      
      document.documentElement.style.setProperty("--app-height", `${vh}px`);
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

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", updateAppHeight);
      window.visualViewport.addEventListener("scroll", updateAppHeight);
    }
    window.addEventListener("resize", updateAppHeight);
    updateAppHeight();

    return () => {
      document.documentElement.classList.remove("terminal-page");
      document.removeEventListener("touchmove", preventScroll);
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
        alert("Failed to create session: " + result.error);
      } else if (result.sessionId) {
        // Add newly created session to openedSessions
        addOpenedSession(result.sessionId);
      }
    });
  }, [createSession, addOpenedSession]);

  const handleSelectSession = useCallback((sessionId) => {
    addOpenedSession(sessionId);
    // Check if we're already in a terminal view
    if (currentView.type === "terminal") {
      // Replace current terminal view instead of pushing (no stack)
      const newStack = [...viewStack];
      newStack[newStack.length - 1] = { type: "terminal", sessionId };
      setViewStack(newStack);
    } else {
      // Push new terminal view (from SessionList)
      pushView({ type: "terminal", sessionId });
    }
  }, [addOpenedSession, currentView, viewStack, setViewStack, pushView]);

  const handleDeleteSession = useCallback((sessionId) => {
    deleteSession(sessionId, () => {
      removeOpenedSession(sessionId);
    });
  }, [deleteSession, removeOpenedSession]);

  const handleRenameSession = useCallback((sessionId, newName) => {
    renameSession(sessionId, newName, (result) => {
      if (!result.success) {
        alert("Failed to rename session: " + result.error);
      }
    });
  }, [renameSession]);

  const handleOpenRemote = useCallback(() => {
    pushView({ type: "remote" });
  }, [pushView]);

  const handleOpenClaw = useCallback(() => {
    pushView({ type: "openclaw" });
  }, [pushView]);

  const handleOpenFiles = useCallback(async () => {
    // Fetch system info when opening workspaces view
    if (!systemInfo) {
      const info = await fileSocket.getSystemInfo();
      if (info.success) {
        setSystemInfo(info);
      }
    }
    pushView({ type: "workspaces" });
  }, [pushView, fileSocket, systemInfo]);

  const handleSelectWorkspace = useCallback((workspacePath) => {
    addRecentWorkspace(workspacePath);
    pushView({ type: "files", workspace: workspacePath });
  }, [pushView]);

  const handleBrowseFolder = useCallback((startPath) => {
    pushView({ type: "browse", path: startPath });
  }, [pushView]);

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
    // Replace browse view with files view (workspace mode)
    addRecentWorkspace(workspacePath);
    storePopView(); // Remove browse view
    pushView({ type: "files", workspace: workspacePath });
  }, [storePopView, pushView]);

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
      title: "Logout",
      message: "Are you sure you want to logout?",
      onConfirm: handleDisconnect
    });
  }, [handleDisconnect]);

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog({ isOpen: false, title: "", message: "", onConfirm: null });
  }, []);

  // Only show loading on initial mount or hydration
  const auth = getAuth();
  const isInitializing = !hydrated || (!socket && !auth?.tunnelUrl);
  
  if (isInitializing) {
    return (
      <div className="min-h-screen bg-dark-700 flex items-center justify-center">
        <div className="text-dark-100">Loading...</div>
      </div>
    );
  }

  return (
    <>
      {/* <MobileBackgroundImage /> */}
      <div className="terminal-container h-[var(--app-height,100vh)] fixed inset-0 overflow-hidden overscroll-none">
      {/* Session List */}
      <div 
        className={`absolute inset-0 transition-all duration-300 ease-out ${
          currentView.type === "list" 
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
          onOpenRemote={remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null}
          onOpenFiles={handleOpenFiles}
          onOpenClaw={handleOpenClaw}
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
        />
      </div>

      {/* Terminals - keep alive for caching */}
      {openedSessions.map((sessionId) => {
        const isActive = currentView.type === "terminal" && currentView.sessionId === sessionId;
        // Check if we're in terminal view (for slide animation from list)
        const isTerminalView = currentView.type === "terminal";
        return (
          <div 
            key={sessionId}
            className={`absolute inset-0 transition-all duration-300 ease-out ${
              isTerminalView
                ? "translate-x-0"
                : "translate-x-full"
            } ${
              isActive 
                ? "opacity-100 z-10" 
                : "opacity-0 z-0 pointer-events-none"
            }`}
          >
            <Terminal 
              socket={socket}
              connected={connected}
              sessionId={sessionId}
              isActive={isActive}
              theme={theme}
              onThemeChange={handleThemeChange}
              onBack={popView}
              onLogout={handleLogoutWithConfirm}
              onOpenRemote={remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null}
              onOpenFiles={handleOpenFiles}
              onSelectSite={handleOpenSite}
              tunnelUrl={auth?.tunnelUrl}
              apiKey={auth?.apiKey}
              connectionMode={connectionMode}
              codespaceInfo={codespaceInfo}
              onStopCodespace={stopCodespace}
              sessions={sessions}
              openedSessions={openedSessions}
              onSwitchSession={handleSelectSession}
              platform={platform}
              subscribeToPush={subscribeToPush}
              unsubscribeFromPush={unsubscribeFromPush}
              notifications={notifications}
              clearNotification={clearNotification}
            />
          </div>
        );
      })}

      {/* Remote Desktop - conditional render */}
      {currentView.type === "remote" && (
        <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-right">
          <RemoteDesktop onClose={popView} socketRef={socketRef} connected={connected} connectionMode={connectionMode} />
        </div>
      )}

      {/* OpenClaw - conditional render */}
      {currentView.type === "openclaw" && (
        <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-right">
          <OpenClawChat onClose={popView} socketRef={openclawSocketRef} connected={openclawConnected} />
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
      <ConnectionModal retryStatus={retryStatus} onLogout={handleDisconnect} />

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
