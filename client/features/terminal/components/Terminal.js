"use client";

import { useEffect, useRef, memo, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";
import AITerminalPanel from "@/features/terminal/components/AITerminal/AITerminalPanel";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useXTerm } from "@/features/terminal/hooks/useXTerm";
import { THEMES } from "@/features/terminal/constants/themes";
import { ChevronLeft, Settings, Sparkles } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

function Terminal({ 
  socket, 
  connected, 
  sessionId, 
  isActive = true, 
  theme = "default", 
  onThemeChange, 
  onBack, 
  onLogout, 
  onOpenRemote, 
  onOpenFiles, 
  tunnelUrl, 
  apiKey, 
  codespaceInfo, 
  onStopCodespace, 
  sessions = [], 
  onSwitchSession,
  platform
}) {
  const containerRef = useRef(null);
  const tabsContainerRef = useRef(null);
  const activeTabRef = useRef(null);
  const menuSocketRef = useRef(null);
  const longPressTimer = useRef(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [showPastePopup, setShowPastePopup] = useState(false);

  const { open: openMenu, setContext, setCallbacks } = useSlideMenuStore();

  // Update socket ref outside render
  useEffect(() => {
    menuSocketRef.current = socket;
  }, [socket]);
  const { doResize, focus } = useXTerm({ socket, sessionId, theme, isActive, containerRef });

  // Auto scroll to active tab
  useEffect(() => {
    if (isActive && activeTabRef.current && tabsContainerRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [sessionId, isActive]);

  // Set up menu context - only when active
  useEffect(() => {
    if (!isActive) return;
    
    setContext({
      connected,
      remoteAvailable: !!onOpenRemote,
      codespaceInfo,
      showTheme: true,
      theme,
      socketRef: menuSocketRef,
      tunnelUrl,
      apiKey
    });

    setCallbacks({
      onRemote: onOpenRemote,
      onFiles: onOpenFiles,
      onSites: null,
      onCodespace: null,
      onLogout,
      onThemeChange,
      onStopCodespace,
    });
  }, [isActive, connected, onOpenRemote, onOpenFiles, codespaceInfo, onLogout, onStopCodespace, theme, onThemeChange, tunnelUrl, apiKey, setContext, setCallbacks]);

  const currentTheme = THEMES[theme] || THEMES.default;

  // Long press handlers for paste popup
  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(() => {
      vibrate();
      setShowPastePopup(true);
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && socket) {
        socket.emit("input", { sessionId, data: text });
        vibrate();
      }
    } catch (err) {
      console.error("Clipboard read failed:", err);
    }
    setShowPastePopup(false);
  };

  return (
    <div className="h-[var(--app-height,100vh)] flex flex-col overflow-hidden" style={{ background: currentTheme.background }}>
      {/* Header */}
      <div className="bg-dark-600 border-b border-dark-400 px-2 sm:px-4 py-2 flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => { vibrate(); onBack(); }}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
          title="Back"
        >
          <ChevronLeft size={20} />
        </button>

        {/* Terminal Tabs */}
        <div ref={tabsContainerRef} className="flex-1 overflow-auto overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-dark-400 scrollbar-track-transparent">
          <div className="flex gap-0.5 min-w-max">
            {sessions.map((session) => {
              const isActiveTab = session.id === sessionId;
              return (
                <button
                  key={session.id}
                  ref={isActiveTab ? activeTabRef : null}
                  onClick={() => { vibrate(); onSwitchSession?.(session.id); }}
                  className={`px-2 py-1 text-sm font-medium transition-colors duration-200 flex items-center gap-2 whitespace-nowrap ${
                    isActiveTab ? "text-brand-500" : "text-dark-50 hover:text-white"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
                  <span className="truncate max-w-[120px]">{session.name || "Terminal"}</span>
                </button>
              );
            })}
          </div>
        </div>

        <button
          onClick={() => { vibrate(); setAiPanelOpen(true); }}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
          title="AI Terminal"
        >
          <Sparkles size={20} />
        </button>

        <button
          onClick={() => { vibrate(); openMenu(); }}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
          title="Menu"
        >
          <Settings size={20} />
        </button>
      </div>

      {/* Terminal Container */}
      <div className="terminal-wrapper flex-1 min-h-0 overflow-hidden p-2 sm:p-4">
        <div 
          ref={containerRef} 
          className="xterm-screen w-full h-full rounded-sm overflow-hidden"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchEnd}
        />
      </div>

      {/* Paste Popup */}
      {showPastePopup && (
        <div 
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowPastePopup(false)}
        >
          <button
            onClick={(e) => { e.stopPropagation(); handlePaste(); }}
            className="px-6 py-3 bg-dark-500 hover:bg-dark-400 text-white rounded-brand border border-dark-400 hover:border-brand-500 font-medium transition-all duration-200"
          >
            Paste
          </button>
        </div>
      )}

      {/* Mobile Keyboard */}
      <MobileKeyboard socket={socket} sessionId={sessionId} onExpandChange={doResize} onRefocus={focus} platform={platform} />

      {/* AI Terminal Panel */}
      <AITerminalPanel isOpen={aiPanelOpen} onClose={() => setAiPanelOpen(false)} platform={platform} />
    </div>
  );
}

export default memo(Terminal, (prev, next) => (
  prev.sessionId === next.sessionId &&
  prev.isActive === next.isActive &&
  prev.connected === next.connected &&
  prev.theme === next.theme &&
  prev.sessions === next.sessions &&
  prev.platform === next.platform
));
