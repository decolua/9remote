"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import SitesList from "./SitesList";
import MobileKeyboard from "./MobileKeyboard";

// Terminal color themes
const THEMES = {
  slate: {
    background: "#0f172a", foreground: "#e2e8f0", cursor: "#3b82f6",
    black: "#1e293b", red: "#ef4444", green: "#22c55e", yellow: "#eab308",
    blue: "#3b82f6", magenta: "#a855f7", cyan: "#06b6d4", white: "#cbd5e1",
    brightBlack: "#475569", brightRed: "#f87171", brightGreen: "#4ade80",
    brightYellow: "#facc15", brightBlue: "#60a5fa", brightMagenta: "#c084fc",
    brightCyan: "#22d3ee", brightWhite: "#f1f5f9"
  },
  dracula: {
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
    brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
    brightCyan: "#a4ffff", brightWhite: "#ffffff"
  },
  monokai: {
    background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0",
    black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75",
    blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
    brightBlack: "#75715e", brightRed: "#f92672", brightGreen: "#a6e22e",
    brightYellow: "#f4bf75", brightBlue: "#66d9ef", brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4", brightWhite: "#f9f8f5"
  },
  nord: {
    background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
    black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
    brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb", brightWhite: "#eceff4"
  }
};

export default function Terminal({ socket, sessionId, isActive = true, theme = "slate", onThemeChange, onBack, tunnelUrl }) {
  const terminalRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const outputHandlerRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [showThemePicker, setShowThemePicker] = useState(false);

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
      cursorBlink: true,
      fontSize: window.innerWidth < 768 ? 12 : 14,
      fontFamily: '"SF Mono", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
      theme: THEMES[theme],
      // Mobile touch scroll options
      scrollOnUserInput: true,
      fastScrollModifier: "none",
      smoothScrollDuration: 0
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
    let scrollAccumulator = 0; // Accumulate fractional scroll
    let animationId = null;
    let lastTime = 0;
    const lineHeight = 16; // Approximate line height in pixels

    const handleTouchStart = (e) => {
      if (e.touches.length === 1) {
        // Stop any ongoing inertia animation
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

        // Smooth velocity calculation with averaging
        if (deltaTime > 0) {
          const newVelocity = deltaY / deltaTime;
          velocity = velocity * 0.7 + newVelocity * 0.3; // Smooth velocity
        }

        lastTouchY = touchY;
        lastTime = now;

        // Accumulate scroll and apply when >= 1 line
        scrollAccumulator += deltaY / lineHeight;
        const linesToScroll = Math.trunc(scrollAccumulator);

        if (linesToScroll !== 0) {
          term.scrollLines(linesToScroll);
          scrollAccumulator -= linesToScroll; // Keep remainder
        }
      }
    };

    const handleTouchEnd = () => {
      // Apply inertia scrolling with smooth deceleration
      const friction = 0.92;
      const minVelocity = 0.005;

      const inertiaScroll = () => {
        if (Math.abs(velocity) < minVelocity) {
          animationId = null;
          velocity = 0;
          scrollAccumulator = 0;
          return;
        }

        // Calculate scroll based on velocity
        const deltaY = velocity * 16; // ~16ms per frame at 60fps
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
