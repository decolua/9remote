"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import dynamic from "next/dynamic";

const Terminal = dynamic(() => import("@/components/Terminal"), { ssr: false });
const SessionList = dynamic(() => import("@/components/SessionList"), { ssr: false });

export default function TerminalPage() {
  const [config, setConfig] = useState(null);
  const [view, setView] = useState("list"); // "list" | "terminal"
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [openedSessions, setOpenedSessions] = useState([]); // Track opened sessions for caching
  const [theme, setTheme] = useState("slate");
  const socketRef = useRef(null);
  const router = useRouter();

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

  // Initialize socket connection
  useEffect(() => {
    const apiKey = sessionStorage.getItem("apiKey");
    const tunnelUrl = sessionStorage.getItem("tunnelUrl");
    
    if (!apiKey || !tunnelUrl) {
      router.push("/");
      return;
    }
    
    setConfig({ apiKey, tunnelUrl });

    // Connect socket
    const socket = io(tunnelUrl, {
      path: "/socket.io",
      transports: ["polling", "websocket"]
    });

    socket.on("connect", () => {
      console.log("Socket connected");
      loadSessions(socket);
    });

    socket.on("sessionClosed", (sessionId) => {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      setOpenedSessions(prev => prev.filter(id => id !== sessionId));
      if (selectedSession === sessionId) {
        setView("list");
        setSelectedSession(null);
      }
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
    };
  }, [router]);

  const loadSessions = useCallback((socket) => {
    socket.emit("getSessions", (list) => {
      setSessions(list);
      // Clean up openedSessions that no longer exist
      setOpenedSessions(prev => prev.filter(id => list.some(s => s.id === id)));
    });
  }, []);

  const handleCreateSession = useCallback(async (name) => {
    const socket = socketRef.current;
    if (!socket) return;

    socket.emit("createSession", { name }, (result) => {
      if (result.success) {
        loadSessions(socket);
      } else {
        alert("Failed to create session: " + result.error);
      }
    });
  }, [loadSessions]);

  const handleSelectSession = useCallback((sessionId) => {
    setSelectedSession(sessionId);
    // Add to opened sessions if not already there
    setOpenedSessions(prev => prev.includes(sessionId) ? prev : [...prev, sessionId]);
    setView("terminal");
  }, []);

  const handleDeleteSession = useCallback((sessionId) => {
    const socket = socketRef.current;
    if (!socket) return;

    socket.emit("deleteSession", sessionId, (result) => {
      if (result.success) {
        setOpenedSessions(prev => prev.filter(id => id !== sessionId));
        loadSessions(socket);
      }
    });
  }, [loadSessions]);

  const handleBack = useCallback(() => {
    setView("list");
    // Don't clear selectedSession - keep terminal alive
    if (socketRef.current) {
      loadSessions(socketRef.current);
    }
  }, [loadSessions]);

  const handleDisconnect = useCallback(() => {
    sessionStorage.clear();
    router.push("/");
  }, [router]);

  if (!config) {
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
            socket={socketRef.current}
            sessionId={sessionId}
            isActive={view === "terminal" && selectedSession === sessionId}
            theme={theme}
            onThemeChange={setTheme}
            onBack={handleBack}
            tunnelUrl={config?.tunnelUrl}
          />
        </div>
      ))}
    </div>
  );
}
