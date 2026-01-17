"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import SitesList from "@/features/terminal/components/SitesList";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";
import { THEMES } from "@/features/terminal/constants/themes";
import { TERMINAL_OPTIONS } from "@/features/terminal/constants/terminalConfig";

export default function Terminal({ socket, sessionId, isActive = true, theme = "slate", onThemeChange, onBack, tunnelUrl }) {
  const terminalRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const outputHandlerRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [showThemePicker, setShowThemePicker] = useState(false);

  // Touch scroll will be set up after terminal is initialized

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
      theme: THEMES[theme]
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
    const resizeObserver = new ResizeObserver(() => {
      doResize();
      // Scroll to bottom after resize
      setTimeout(() => termRef.current?.scrollToBottom(), 500);
    });
    resizeObserver.observe(termElement);

    // Join session - get history
    socket.emit("joinSession", sessionId, (result) => {
      if (result.success) {
        setConnected(true);
        setSessionName(result.name);
      } else {
        term.write(`\r\n\x1b[1;31mError: ${result.error}\x1b[0m\r\n`);
      }
    });

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
      if (inputHandlerRef.current) {
        inputHandlerRef.current.dispose();
      }
      fitAddon.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [socket, sessionId, theme, doResize]);

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
    if (termRef.current && THEMES[theme]) {
      termRef.current.options.theme = THEMES[theme];
    }
  }, [theme]);

  return (
    <div className="h-[var(--app-height,100vh)] flex flex-col overflow-hidden" style={{ background: THEMES[theme].background }}>
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-2 sm:px-6 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center space-x-2 sm:space-x-3">
          <button
            onClick={onBack}
            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded transition"
          >
            ← Back
          </button>
          <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
          <h1 className="text-white text-sm sm:text-base font-semibold truncate max-w-[150px] sm:max-w-none">
            {sessionName || "Terminal"}
          </h1>
        </div>

        <div className="flex items-center space-x-2">
          {/* Remote Desktop Button */}
          <a
            href="/remote"
            className="px-2 sm:px-3 py-1 sm:py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs sm:text-sm font-medium rounded transition flex items-center gap-1"
          >
            <svg className="w-3 h-3 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <span className="hidden sm:inline">Remote</span>
          </a>

          {/* Sites List */}
          <SitesList tunnelUrl={tunnelUrl} />

          {/* Theme Picker */}
          <div className="relative">
            <button
              onClick={() => setShowThemePicker(!showThemePicker)}
              className="px-2 sm:px-3 py-1 sm:py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs sm:text-sm font-medium rounded transition flex items-center gap-1"
            >
              <span className="w-3 h-3 rounded-full" style={{ background: THEMES[theme].cursor }} />
              <span className="hidden sm:inline">Theme</span>
            </button>

            {showThemePicker && (
              <div className="absolute right-0 top-full mt-2 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 p-2 min-w-[120px]">
                {Object.keys(THEMES).map((t) => (
                  <button
                    key={t}
                    onClick={() => { onThemeChange(t); setShowThemePicker(false); }}
                    className={`w-full px-3 py-2 text-left text-sm rounded flex items-center gap-2 ${theme === t ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-700"
                      }`}
                  >
                    <span className="w-3 h-3 rounded-full" style={{ background: THEMES[t].background, border: "1px solid #555" }} />
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Terminal */}
      <div className="terminal-wrapper flex-1 min-h-0 overflow-hidden p-2 sm:p-4">
        <div
          ref={terminalRef}
          className="w-full h-full rounded-lg overflow-hidden shadow-2xl"
        />
      </div>

      {/* Mobile Keyboard */}
      <MobileKeyboard
        socket={socket}
        sessionId={sessionId}
        onExpandChange={doResize}
      />
    </div>
  );
}
