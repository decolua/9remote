"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useSocket } from "@/features/terminal/hooks/useSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";

const Terminal = dynamic(() => import("@/features/terminal/components/Terminal"), { ssr: false });
const SessionList = dynamic(() => import("@/features/terminal/components/SessionList"), { ssr: false });

export default function TerminalPage() {
  const [view, setView] = useState("list"); // "list" | "terminal"
  const [selectedSession, setSelectedSession] = useState(null);
  const [openedSessions, setOpenedSessions] = useState([]); // Track opened sessions for caching
  const [theme, setTheme] = useState("slate");
  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const { socket, sessions, loadSessions, createSession, deleteSession } = useSocket();

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
      
      // Force scroll to top to prevent iOS scroll offset
      window.scrollTo(0, 0);
    };

    // Disable body scroll on mobile - add class to html
    document.documentElement.classList.add("terminal-page");

    // Prevent touchmove on document to stop iOS scroll
    const preventScroll = (e) => {
      // Allow scroll inside terminal (xterm-viewport for scrolling)
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
      // Restore body scroll - remove class from html
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
    setSelectedSession(sessionId);
    // Add to opened sessions if not already there
    setOpenedSessions(prev => prev.includes(sessionId) ? prev : [...prev, sessionId]);
    setView("terminal");
  }, []);

  const handleDeleteSession = useCallback((sessionId) => {
    deleteSession(sessionId, () => {
      setOpenedSessions(prev => prev.filter(id => id !== sessionId));
    });
  }, [deleteSession]);

  const handleBack = useCallback(() => {
    setView("list");
    // Don't clear selectedSession - keep terminal alive
    loadSessions();
  }, [loadSessions]);

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
      {/* Session List - show/hide based on view */}
      <div className={view === "list" ? "h-full" : "hidden"}>
        <SessionList
          sessions={sessions}
          onSelect={handleSelectSession}
          onCreate={handleCreateSession}
          onDelete={handleDeleteSession}
          onDisconnect={handleDisconnect}
        />
      </div>

      {/* Render all opened terminals - show/hide based on selection */}
      {openedSessions.map((sessionId) => (
        <div 
          key={sessionId} 
          className={view === "terminal" && selectedSession === sessionId ? "block h-full" : "hidden"}
        >
          <Terminal 
            socket={socket}
            sessionId={sessionId}
            isActive={view === "terminal" && selectedSession === sessionId}
            theme={theme}
            onThemeChange={setTheme}
            onBack={handleBack}
            tunnelUrl={auth?.tunnelUrl}
          />
        </div>
      ))}
    </div>
  );
}
