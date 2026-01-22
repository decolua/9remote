"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useSocket } from "@/features/terminal/hooks/useSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useTerminalStore } from "@/shared/stores/terminalStore";

const Terminal = dynamic(() => import("@/features/terminal/components/Terminal"), { ssr: false });
const SessionList = dynamic(() => import("@/features/terminal/components/SessionList"), { ssr: false });
const RemoteDesktop = dynamic(() => import("@/features/remote/components/RemoteDesktop"), { ssr: false });
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
  const { socket, connected, sessions, remoteAvailable, codespaceInfo, codespaceDisconnected, retryStatus, loadSessions, createSession, deleteSession, renameSession, stopCodespace } = useSocket();

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
      if (e.target.closest(".xterm-viewport") || e.target.closest(".xterm-screen")) return;
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
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
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
        <div className="absolute inset-0 z-20 animate-in slide-in-from-right duration-300">
          <RemoteDesktop onClose={popView} />
        </div>
      )}

      {/* Connection Modal - overlay when retrying/failed */}
      <ConnectionModal retryStatus={retryStatus} onLogout={handleDisconnect} />
    </div>
  );
}
