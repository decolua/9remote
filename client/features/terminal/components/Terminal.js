"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { THEMES } from "@/features/terminal/constants/themes";
import { TERMINAL_OPTIONS } from "@/features/terminal/constants/terminalConfig";
import { ChevronLeft, Settings } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

export default function Terminal({ socket, connected: wsConnected, sessionId, isActive = true, theme = "default", onThemeChange, onBack, onLogout, onOpenRemote, onOpenFiles, onSelectSite, tunnelUrl, apiKey, codespaceInfo, onStopCodespace, sessions = [], openedSessions = [], onSwitchSession }) {
  const terminalRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const outputHandlerRef = useRef(null);

  const [sessionConnected, setSessionConnected] = useState(false);
  const [sessionName, setSessionName] = useState("");

  // Slide menu store
  const { open: openMenu, setContext, setCallbacks } = useSlideMenuStore();

  // Ref for tabs container to auto-scroll to active tab
  const tabsContainerRef = useRef(null);
  const activeTabRef = useRef(null);

  // Auto scroll to active tab when sessionId changes
  useEffect(() => {
    if (isActive && activeTabRef.current && tabsContainerRef.current) {
      activeTabRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center'
      });
    }
  }, [sessionId, isActive]);

  // Socket ref for menu context
  const menuSocketRef = useRef(null);
  menuSocketRef.current = socket;

  // Set up menu context and callbacks - only when active
  useEffect(() => {
    if (!isActive) return;
    
    setContext({
      connected: wsConnected,
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
      onSites: null, // Sites handled by SitesList modal
      onCodespace: null,
      onLogout,
      onThemeChange,
      onStopCodespace,
    });
  }, [
    isActive,
    wsConnected, 
    onOpenRemote, 
    onOpenFiles, 
    codespaceInfo, 
    onLogout, 
    onStopCodespace,
    theme,
    onThemeChange,
    tunnelUrl,
    apiKey,
    setContext,
    setCallbacks
  ]);

  // Centralized resize handler - single source of truth
  const doResize = useCallback(() => {
    if (!fitAddonRef.current || !termRef.current || !socket) return;
    fitAddonRef.current.fit();
    socket.emit("resize", { sessionId, cols: termRef.current.cols, rows: termRef.current.rows });
  }, [socket, sessionId]);

  // Initialize terminal ONCE
  useEffect(() => {
    if (!terminalRef.current || !socket || !sessionId) return;
    if (termRef.current) return; // Already initialized

    const term = new XTerm({
      ...TERMINAL_OPTIONS,
      fontSize: window.innerWidth < 768 ? TERMINAL_OPTIONS.fontSizeMobile : TERMINAL_OPTIONS.fontSize,
      fontFamily: TERMINAL_OPTIONS.fontFamily,
      theme: THEMES[theme] || THEMES.default
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.open(terminalRef.current);
    setTimeout(() => fitAddon.fit(), 100);

    // Enable smooth touch scroll on mobile with inertia
    const termElement = terminalRef.current;
    let lastTouchY = 0;
    let velocity = 0;
    let scrollAccumulator = 0;
    let animationId = null;
    let lastTime = 0;
    const lineHeight = 16;

    const handleTouchStart = (e) => {
      if (e.touches.length === 1) {
        if (animationId) {
          cancelAnimationFrame(animationId);
          animationId = null;
        }
        lastTouchY = e.touches[0].clientY;
        lastTime = performance.now();
        velocity = 0;
        scrollAccumulator = 0;
      }
    };

    const handleTouchMove = (e) => {
      if (e.touches.length === 1) {
        e.preventDefault(); // Prevent page scroll, handle scroll ourselves
        
        const touchY = e.touches[0].clientY;
        const now = performance.now();
        const deltaY = lastTouchY - touchY;
        const deltaTime = now - lastTime;

        if (deltaTime > 0) {
          const newVelocity = deltaY / deltaTime;
          velocity = velocity * 0.7 + newVelocity * 0.3;
        }

        lastTouchY = touchY;
        lastTime = now;

        scrollAccumulator += deltaY / lineHeight;
        const linesToScroll = Math.trunc(scrollAccumulator);

        if (linesToScroll !== 0) {
          term.scrollLines(linesToScroll);
          scrollAccumulator -= linesToScroll;
        }
      }
    };

    const handleTouchEnd = () => {
      const friction = 0.92;
      const minVelocity = 0.005;

      const inertiaScroll = () => {
        if (Math.abs(velocity) < minVelocity) {
          animationId = null;
          velocity = 0;
          scrollAccumulator = 0;
          return;
        }

        const deltaY = velocity * 16;
        scrollAccumulator += deltaY / lineHeight;
        const linesToScroll = Math.trunc(scrollAccumulator);

        if (linesToScroll !== 0) {
          term.scrollLines(linesToScroll);
          scrollAccumulator -= linesToScroll;
        }

        velocity *= friction;
        animationId = requestAnimationFrame(inertiaScroll);
      };

      if (Math.abs(velocity) > minVelocity) {
        animationId = requestAnimationFrame(inertiaScroll);
      }
    };

    termElement.addEventListener("touchstart", handleTouchStart, { passive: true });
    termElement.addEventListener("touchmove", handleTouchMove, { passive: true });
    termElement.addEventListener("touchend", handleTouchEnd, { passive: true });

    // ResizeObserver handles all container size changes (window resize, keyboard, orientation)
    // Debounce to prevent excessive fits during animations
    let resizeTimeout = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      
      resizeTimeout = setTimeout(() => {
        // doResize();
        fitAddonRef.current.fit();
        termRef.current?.scrollToBottom();
      }, 100);
    });
    resizeObserver.observe(termElement);

    // Join session - get history
    socket.emit("joinSession", sessionId, (result) => {
      if (result.success) {
        setSessionConnected(true);
        setSessionName(result.name);
      } else {
        term.write(`\r\n\x1b[1;31mError: ${result.error}\x1b[0m\r\n`);
      }
    });

    // Listen for session rename events
    const handleSessionRenamed = ({ sessionId: renamedId, name }) => {
      if (renamedId === sessionId) {
        setSessionName(name);
      }
    };
    socket.on("session-renamed", handleSessionRenamed);

    // Global output handler - filter by sessionId
    const handleOutput = (payload) => {
      if (payload.sessionId !== sessionId) return;

      const data = payload.data;
      if (data instanceof ArrayBuffer || (data && data.buffer)) {
        term.write(new Uint8Array(data));
      } else if (typeof data === "string") {
        term.write(data);
      } else {
        term.write(String(data));
      }
    };
    outputHandlerRef.current = handleOutput;
    socket.on("output", handleOutput);

    // Orientationchange needs delay for mobile (ResizeObserver handles window.resize)
    const handleOrientationChange = () => setTimeout(doResize, 300);
    window.addEventListener("orientationchange", handleOrientationChange);

    return () => {
      window.removeEventListener("orientationchange", handleOrientationChange);
      termElement.removeEventListener("touchstart", handleTouchStart);
      termElement.removeEventListener("touchmove", handleTouchMove);
      termElement.removeEventListener("touchend", handleTouchEnd);
      resizeObserver.disconnect();
      if (animationId) cancelAnimationFrame(animationId);
      if (outputHandlerRef.current) {
        socket.off("output", outputHandlerRef.current);
      }
      socket.off("session-renamed", handleSessionRenamed);
      if (inputHandlerRef.current) {
        inputHandlerRef.current.dispose();
      }
      fitAddon.dispose();
      term.dispose();
      termRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, sessionId]); // Don't include theme - handled by separate useEffect

  // Manage input handler based on isActive
  useEffect(() => {
    if (!termRef.current || !socket || !sessionId) return;

    // Remove old input handler
    if (inputHandlerRef.current) {
      inputHandlerRef.current.dispose();
      inputHandlerRef.current = null;
    }

    // Only attach when active
    if (isActive) {
      inputHandlerRef.current = termRef.current.onData((data) => {
        socket.emit("input", { sessionId, data });
      });
    }
  }, [isActive, socket, sessionId]);

  // Re-fit when becoming visible
  useEffect(() => {
    if (!isActive || !fitAddonRef.current || !termRef.current) return;
    const timer = setTimeout(doResize, 100);
    return () => clearTimeout(timer);
  }, [isActive, doResize]);

  // Update theme
  useEffect(() => {
    const currentTheme = THEMES[theme] || THEMES.default;
    if (termRef.current) {
      termRef.current.options.theme = currentTheme;
    }
  }, [theme]);

  return (
    <div className="h-[var(--app-height,100vh)] flex flex-col overflow-hidden" style={{ background: (THEMES[theme] || THEMES.default).background }}>
      {/* Header */}
      <div className="bg-dark-600 border-b border-dark-400 px-2 sm:px-4 py-2 flex items-center gap-2 flex-shrink-0">
        {/* Back Button */}
        <button
          onClick={() => { vibrate(); onBack(); }}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
          title="Back"
        >
          <ChevronLeft size={20} />
        </button>

        {/* Terminal Tabs - Horizontal Scroll */}
        <div 
          ref={tabsContainerRef}
          className="flex-1 overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-dark-400 scrollbar-track-transparent"
        >
          <div className="flex gap-0.5 min-w-max">
            {sessions.map((session) => {
              const isActiveTab = session.id === sessionId;
              return (
                <button
                  key={session.id}
                  ref={isActiveTab ? activeTabRef : null}
                  onClick={() => onSwitchSession && onSwitchSession(session.id)}
                  className={`px-2 py-1 text-sm font-medium transition-colors duration-200 flex items-center gap-2 whitespace-nowrap ${
                    isActiveTab
                      ? " text-brand-500"
                      : "border-dark-400 text-dark-50 hover:border-brand-500 hover:text-white"
                  }`}
                >
                  <span 
                    className={`w-1.5 h-1.5 rounded-full ${wsConnected ? "bg-green-400" : "bg-red-400"}`}
                  />
                  <span className="truncate max-w-[120px]">
                    {session.name || "Terminal"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Menu Button */}
        <button
          onClick={() => { vibrate(); openMenu(); }}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
          title="Menu"
        >
          <Settings size={20} />
        </button>
      </div>

      {/* Terminal */}
      <div className="terminal-wrapper flex-1 min-h-0 overflow-hidden p-2 sm:p-4">
        <div
          ref={terminalRef}
          className="xterm-screen w-full h-full rounded-sm overflow-hidden"
        />
      </div>

      {/* Mobile Keyboard */}
      <MobileKeyboard
        socket={socket}
        sessionId={sessionId}
        onExpandChange={doResize}
        onRefocus={() => termRef.current?.focus()}
      />
    </div>
  );
}
