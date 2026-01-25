"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useSocket } from "@/features/terminal/hooks/useSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useFileSocket } from "@/features/fileExplorer/hooks/useFileSocket";
import { addRecentWorkspace } from "@/features/fileExplorer/components/WorkspaceList";

const Terminal = dynamic(() => import("@/features/terminal/components/Terminal"), { ssr: false });
const SessionList = dynamic(() => import("@/features/terminal/components/SessionList"), { ssr: false });
const RemoteDesktop = dynamic(() => import("@/features/remote/components/RemoteDesktop"), { ssr: false });
const WorkspaceList = dynamic(() => import("@/features/fileExplorer/components/WorkspaceList"), { ssr: false });
const FileExplorer = dynamic(() => import("@/features/fileExplorer/components/FileExplorer"), { ssr: false });
const FileEditor = dynamic(() => import("@/features/fileExplorer/components/FileEditor"), { ssr: false });
const GitPanel = dynamic(() => import("@/features/fileExplorer/components/GitPanel"), { ssr: false });
import ConnectionModal from "@/shared/components/ui/ConnectionModal";

export default function TerminalPage() {
  // Hydration state for Zustand
  const [hydrated, setHydrated] = useState(false);
  
  // UI state from Zustand store (persisted to sessionStorage)
  const { 
    viewStack, 
    openedSessions, 
    pushView, 
    popView: storePopView, 
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
      return localStorage.getItem("terminal_theme") || "dracula";
    }
    return "dracula";
  });
  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const { socket, socketRef, connected, sessions, remoteAvailable, codespaceInfo, codespaceDisconnected, retryStatus, loadSessions, createSession, deleteSession, renameSession, stopCodespace } = useSocket();
  const fileSocket = useFileSocket(socketRef);

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
    storePopView();
    loadSessions();
  }, [storePopView, loadSessions]);

  // Load sessions when socket connects
  useEffect(() => {
    if (socket) {
      loadSessions();
    }
  }, [socket, loadSessions]);

  // VisualViewport height - handle mobile keyboard
  useEffect(() => {
    const updateAppHeight = () => {
      const vh = window.visualViewport?.height || window.innerHeight;
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
      }
    });
  }, [createSession]);

  const handleSelectSession = useCallback((sessionId) => {
    addOpenedSession(sessionId);
    pushView({ type: "terminal", sessionId });
  }, [addOpenedSession, pushView]);

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

  const handleOpenFiles = useCallback(() => {
    pushView({ type: "workspaces" });
  }, [pushView]);

  const handleSelectWorkspace = useCallback((workspacePath) => {
    addRecentWorkspace(workspacePath);
    pushView({ type: "files", workspace: workspacePath });
  }, [pushView]);

  const handleBrowseFolder = useCallback((startPath) => {
    pushView({ type: "browse", path: startPath });
  }, [pushView]);

  const handleOpenFile = useCallback((filePath) => {
    pushView({ type: "editor", path: filePath });
  }, [pushView]);

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
          onDisconnect={handleDisconnect}
          onOpenRemote={remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null}
          onOpenFiles={handleOpenFiles}
          tunnelUrl={auth?.tunnelUrl}
          apiKey={auth?.apiKey}
          codespaceInfo={codespaceInfo}
          codespaceDisconnected={codespaceDisconnected}
          onStopCodespace={stopCodespace}
          retryStatus={retryStatus}
        />
      </div>

      {/* Terminals - keep alive for caching */}
      {openedSessions.map((sessionId) => {
        const isActive = currentView.type === "terminal" && currentView.sessionId === sessionId;
        return (
          <div 
            key={sessionId} 
            className={`absolute inset-0 transition-all duration-300 ease-out ${
              isActive 
                ? "translate-x-0 opacity-100 z-10" 
                : "translate-x-full opacity-0 z-0 pointer-events-none"
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
              onOpenRemote={remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null}
              onSelectSite={handleOpenSite}
              tunnelUrl={auth?.tunnelUrl}
              apiKey={auth?.apiKey}
            />
          </div>
        );
      })}

      {/* Remote Desktop - conditional render */}
      {currentView.type === "remote" && (
        <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-right">
          <RemoteDesktop onClose={popView} />
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
            fileSocket={fileSocket}
            onBack={popView}
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
    </div>
  );
}
