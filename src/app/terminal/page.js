"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useSocket } from "@/features/terminal/hooks/useSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";

const Terminal = dynamic(() => import("@/features/terminal/components/Terminal"), { ssr: false });
const SessionList = dynamic(() => import("@/features/terminal/components/SessionList"), { ssr: false });
const RemoteDesktop = dynamic(() => import("@/features/remote/components/RemoteDesktop"), { ssr: false });
const SiteView = dynamic(() => import("@/features/terminal/components/SiteView"), { ssr: false });

export default function TerminalPage() {
  // Navigation stack: [{ type: "list" }, { type: "terminal", sessionId }, { type: "remote" }, { type: "site", port, name }]
  const [viewStack, setViewStack] = useState([{ type: "list" }]);
  const [openedSessions, setOpenedSessions] = useState([]);
  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("terminal_theme") || "dracula";
    }
    return "dracula";
  });
  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const { socket, connected, sessions, remoteAvailable, codespaceInfo, loadSessions, createSession, deleteSession, renameSession, stopCodespace } = useSocket();

  // Save theme to localStorage when changed
  const handleThemeChange = useCallback((newTheme) => {
    setTheme(newTheme);
    if (typeof window !== "undefined") {
      localStorage.setItem("terminal_theme", newTheme);
    }
  }, []);

  // Current view is top of stack
  const currentView = viewStack[viewStack.length - 1];

  // Get selected session from stack (find last terminal view)
  const getSelectedSession = () => {
    for (let i = viewStack.length - 1; i >= 0; i--) {
      if (viewStack[i].type === "terminal") return viewStack[i].sessionId;
    }
    return null;
  };
  const selectedSession = getSelectedSession();

  // Navigation helpers
  const pushView = useCallback((view) => {
    setViewStack(prev => [...prev, view]);
  }, []);

  const popView = useCallback(() => {
    setViewStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev);
    loadSessions();
  }, [loadSessions]);

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
    setOpenedSessions(prev => prev.includes(sessionId) ? prev : [...prev, sessionId]);
    pushView({ type: "terminal", sessionId });
  }, [pushView]);

  const handleDeleteSession = useCallback((sessionId) => {
    deleteSession(sessionId, () => {
      setOpenedSessions(prev => prev.filter(id => id !== sessionId));
    });
  }, [deleteSession]);

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
    pushView({ type: "site", port: site.port, name: site.name });
  }, [pushView]);

  const handleDisconnect = useCallback(() => {
    sessionStorage.clear();
    router.push("/");
  }, [router]);

  const auth = getAuth();
  
  if (!socket) {
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
          onSelectSite={handleOpenSite}
          tunnelUrl={auth?.tunnelUrl}
          apiKey={auth?.apiKey}
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
              codespaceInfo={codespaceInfo}
              onStopCodespace={stopCodespace}
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

      {/* Site View - conditional render */}
      {currentView.type === "site" && (
        <div className="absolute inset-0 z-20 animate-in slide-in-from-right duration-300">
          <SiteView 
            port={currentView.port} 
            siteName={currentView.name} 
            onBack={popView} 
          />
        </div>
      )}
    </div>
  );
}
