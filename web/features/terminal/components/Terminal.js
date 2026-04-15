"use client";

import { useEffect, useRef, memo, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";
import { detectSelectionType } from "@/features/terminal/components/SelectionActionButton";
import { parseFilePathWithLine } from "@/features/terminal/utils/linkDetector";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useXTerm } from "@/features/terminal/hooks/useXTerm";
import { THEMES } from "@/features/terminal/constants/themes";
import { ChevronLeft, ChevronDown, Settings, Monitor } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";

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
  connectionMode = "tunnel",
  codespaceInfo,
  onStopCodespace,
  sessions = [],
  onSwitchSession,
  platform,
  subscribeToPush,
  unsubscribeFromPush,
  notifications = {},
  clearNotification,
}) {
  const containerRef = useRef(null);
  const tabsContainerRef = useRef(null);
  const activeTabRef = useRef(null);
  const menuSocketRef = useRef(null);
  const longPressTimer = useRef(null);
  const pasteInputRef = useRef(null);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const { open: openMenu, setContext, setCallbacks } = useSlideMenuStore();
  const { pushView } = useTerminalStore();

  // Update socket ref outside render
  useEffect(() => {
    menuSocketRef.current = socket;
  }, [socket]);
  const { termRef, cwdRef, doResize, focus, stopMomentum } = useXTerm({ socket, sessionId, theme, isActive, containerRef });

  // Auto scroll to active tab
  useEffect(() => {
    if (isActive && activeTabRef.current && tabsContainerRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
    // Clear notification when viewing this session
    if (isActive && sessionId) {
      clearNotification(sessionId);
    }
  }, [sessionId, isActive, clearNotification]);

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
      apiKey,
      connectionMode,
      subscribeToPush,
      unsubscribeFromPush,
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
  }, [isActive, connected, onOpenRemote, onOpenFiles, codespaceInfo, onLogout, onStopCodespace, theme, onThemeChange, tunnelUrl, apiKey, connectionMode, setContext, setCallbacks]);

  const currentTheme = THEMES[theme] || THEMES.default;

  // Try clipboard API first, fallback to input popup
  const tryPasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && socket) {
        socket.emit("input", { sessionId, data: text });
        vibrate();
        return true;
      }
    } catch (err) {
      console.error("Clipboard API failed, showing input fallback:", err);
    }
    return false;
  };

  // Long press handlers for paste
  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(async () => {
      vibrate();
      const success = await tryPasteFromClipboard();
      if (!success) {
        setShowPasteInput(true);
        setTimeout(() => pasteInputRef.current?.focus(), 100);
      }
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Handle paste from input fallback
  const handlePasteInput = (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (text && socket) {
      socket.emit("input", { sessionId, data: text });
      vibrate();
    }
    setShowPasteInput(false);
  };

  // Track scroll position to show/hide scroll-to-bottom button
  useEffect(() => {
    if (!termRef.current || !isActive) return;

    const term = termRef.current;
    const MIN_SCROLL_THRESHOLD = 5; // Only show button when scrolled up more than 5 lines

    const checkScrollPosition = () => {
      const buffer = term.buffer.active;
      const scrollDistance = buffer.baseY - buffer.viewportY;
      setShowScrollButton(scrollDistance > MIN_SCROLL_THRESHOLD);
    };

    const disposable = term.onScroll(checkScrollPosition);
    const dataDisposable = term.onWriteParsed(checkScrollPosition);

    return () => {
      disposable.dispose();
      dataDisposable.dispose();
    };
  }, [termRef, isActive]);

  const handleScrollToBottom = () => {
    if (!termRef.current) return;
    vibrate();
    stopMomentum();
    termRef.current.scrollToBottom();
  };

  // Listen for terminal selection changes - auto open file/URL on double-click
  useEffect(() => {
    if (!termRef.current || !isActive || !socket) return;

    const term = termRef.current;

    const handleSelectionChange = async () => {
      const selection = term.getSelection();

      if (!selection || selection.trim().length === 0) return;

      // Detect if selection is a file or URL
      const detected = detectSelectionType(selection);

      if (detected.isUrl) {
        term.clearSelection();
        window.open(detected.match, "_blank");
        return;
      }

      if (detected.isFile) {
        const { path, line, column } = parseFilePathWithLine(detected.match);
        term.clearSelection();
        
        // Resolve path with cached cwd from OSC 7
        let finalPath = path;
        if (!path.startsWith("/") && cwdRef.current) {
          finalPath = `${cwdRef.current}/${path}`;
        }
        
        // Focus terminal and open file
        if (termRef.current) termRef.current.focus();
        setTimeout(() => {
          pushView({ type: "editor", path: finalPath, line, column });
        }, 50);
      }
    };

    const disposable = term.onSelectionChange(handleSelectionChange);

    return () => {
      disposable.dispose();
    };
  }, [termRef, isActive, socket, sessionId, pushView]);

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: currentTheme.background }}>
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
              const hasNotif = !!notifications[session.id];
              return (
                <button
                  key={session.id}
                  ref={isActiveTab ? activeTabRef : null}
                  onClick={() => {
                    vibrate();
                    clearNotification(session.id);
                    onSwitchSession?.(session.id);
                  }}
                  className={`px-2 py-1 text-sm font-medium transition-colors duration-200 flex items-center gap-2 whitespace-nowrap ${isActiveTab ? "text-brand-500" : "text-dark-50 hover:text-white"
                    }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${hasNotif ? "bg-yellow-400 animate-pulse" : connected ? "bg-green-400" : "bg-red-400"}`} />
                  <span className="truncate max-w-[120px]">{session.name || "Terminal"}</span>
                </button>
              );
            })}
          </div>
        </div>

        {onOpenRemote && (
          <button
            onClick={() => { vibrate(); onOpenRemote(); }}
            className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
            title="Remote Desktop"
          >
            <Monitor size={20} />
          </button>
        )}

        <button
          onClick={() => { vibrate(); openMenu(); }}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
          title="Menu"
        >
          <Settings size={20} />
        </button>
      </div>

      {/* Terminal Container */}
      <div className="terminal-wrapper flex-1 min-h-0 overflow-hidden p-2 sm:p-4 relative">
        <div
          ref={containerRef}
          className="xterm-screen w-full h-full rounded-sm overflow-hidden"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchEnd}
        />

        {/* Scroll to Bottom Button */}
        {showScrollButton && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              handleScrollToBottom();
            }}
            className="absolute bottom-5 right-7 z-50 p-2 bg-black/30 hover:bg-black/50 text-white rounded-full border border-white/20 shadow-lg transition-all duration-200 hover:scale-105"
            title="Scroll to bottom"
          >
            <ChevronDown size={20} />
          </button>
        )}
      </div>

      {/* Paste Input Fallback */}
      {showPasteInput && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowPasteInput(false)}
        >
          <input
            ref={pasteInputRef}
            placeholder="Paste here (Cmd+V)"
            onPaste={handlePasteInput}
            onClick={(e) => e.stopPropagation()}
            className="px-6 py-3 bg-dark-500 text-white rounded-brand border border-dark-400 focus:border-brand-500 font-medium transition-all duration-200 outline-none text-center w-64"
          />
        </div>
      )}

      {/* Mobile Keyboard */}
      <MobileKeyboard socket={socket} sessionId={sessionId} onExpandChange={doResize} onRefocus={focus} platform={platform} />
    </div>
  );
}

export default memo(Terminal, (prev, next) => (
  prev.sessionId === next.sessionId &&
  prev.isActive === next.isActive &&
  prev.connected === next.connected &&
  prev.theme === next.theme &&
  prev.sessions === next.sessions &&
  prev.platform === next.platform &&
  prev.notifications === next.notifications
));
