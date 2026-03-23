"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { THEMES } from "@/features/terminal/constants/themes";
import { TERMINAL_OPTIONS } from "@/features/terminal/constants/terminalConfig";

// XTerm instance management hook
export function useXTerm({ socket, sessionId, theme, isActive, containerRef }) {
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const resizeTimerRef = useRef(null);
  const doResizeRef = useRef(null);
  const stopMomentumRef = useRef(null);
  const cwdRef = useRef(null); // Track current working directory
  const [termReady, setTermReady] = useState(false);

  // Resize with debounce singleton - uses rAF to ensure layout is stable
  const doResize = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      requestAnimationFrame(() => {
        if (!fitAddonRef.current || !termRef.current || !socket) return;
        fitAddonRef.current.fit();
        const { cols, rows } = termRef.current;
        socket.emit("resize", { sessionId, cols, rows });
        resizeTimerRef.current = null;
      });
    }, 150);
  }, [socket, sessionId]);

  // Keep ref updated for use in useEffect without stale closure
  doResizeRef.current = doResize;

  // Initialize XTerm instance
  useEffect(() => {
    if (!containerRef.current || !socket || !sessionId) return;
    if (termRef.current) return;

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

    term.open(containerRef.current);

    // WebGL addon loaded after joinSession to avoid blank screen
    let webglAddon = null;
    const loadWebGL = () => {
      if (webglAddon) return;
      try {
        webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => webglAddon.dispose());
        term.loadAddon(webglAddon);
      } catch (e) {
        console.warn("WebGL not supported, using canvas renderer");
      }
    };

    // Initial fit and mark ready
    let checkCount = 0;
    const maxChecks = 50;
    const checkReady = () => {
      checkCount++;
      const width = containerRef.current?.offsetWidth || 0;
      const height = containerRef.current?.offsetHeight || 0;
      
      if (checkCount > maxChecks) {
        setTermReady(true);
        return;
      }

      if (term.element && width > 0 && height > 0) {
        fitAddon.fit();
        socket.emit("resize", { sessionId, cols: term.cols, rows: term.rows });
        setTermReady(true);
      } else {
        setTimeout(checkReady, 50);
      }
    };
    setTimeout(checkReady, 50);

    // ResizeObserver - delegate to doResize (debounced + rAF)
    const resizeObserver = new ResizeObserver(() => doResizeRef.current?.());
    resizeObserver.observe(containerRef.current);

    // Output handler - filter by sessionId
    const handleOutput = (payload) => {
      if (payload.sessionId !== sessionId) return;
      const data = payload.data;
      
      // Parse OSC 7 sequence to track working directory
      if (typeof data === "string" || data instanceof Uint8Array) {
        const text = typeof data === "string" ? data : String.fromCharCode.apply(null, data);
        const osc7Match = text.match(/\x1b\]7;file:\/\/[^\/]*(.+?)\x07/);
        if (osc7Match && osc7Match[1]) {
          cwdRef.current = decodeURIComponent(osc7Match[1]);
        }
      }
      
      if (data instanceof ArrayBuffer || (data && data.buffer)) {
        term.write(new Uint8Array(data));
      } else if (typeof data === "string") {
        term.write(data);
      } else {
        term.write(String(data));
      }
    };
    socket.on("output", handleOutput);

    // Join session and replay scrollback buffer from daemon
    const doJoinSession = (isRejoin = false) => {
      socket.emit("joinSession", sessionId, (result) => {
        if (result.success) {
          if (result.cwd) cwdRef.current = result.cwd;
          setTimeout(() => {
            loadWebGL();
            fitAddon.fit();
          }, 100);
        } else {
          term.write(`\r\n\x1b[1;31mError: ${result.error}\x1b[0m\r\n`);
        }
      });
    };
    doJoinSession();

    // On reconnect → clear stale content and rejoin to get latest scrollback
    const handleReconnect = () => {
      if (!termRef.current) return;
      termRef.current.reset();
      doJoinSession(true);
    };
    socket.on("connect", handleReconnect);

    // Orientation change handler - delegate to doResize via ref
    const handleOrientationChange = () => setTimeout(() => doResizeRef.current?.(), 300);
    window.addEventListener("orientationchange", handleOrientationChange);

    // Force redraw when tab becomes visible again (WebGL renderer may not repaint after tab switch)
    const handleVisibilityChange = () => {
      if (!document.hidden && termRef.current) {
        termRef.current.refresh(0, termRef.current.rows - 1);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("orientationchange", handleOrientationChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver.disconnect();
      socket.off("connect", handleReconnect);
      socket.off("output", handleOutput);
      if (inputHandlerRef.current) inputHandlerRef.current.dispose();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      if (webglAddon) webglAddon.dispose();
      fitAddon.dispose();
      term.dispose();
      termRef.current = null;
      setTermReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, sessionId]);

  // Input handler - only when active
  useEffect(() => {
    if (!termRef.current || !socket || !sessionId) return;

    if (inputHandlerRef.current) {
      inputHandlerRef.current.dispose();
      inputHandlerRef.current = null;
    }

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
    if (termRef.current) {
      termRef.current.options.theme = THEMES[theme] || THEMES.default;
    }
  }, [theme]);

  // Touch scroll with momentum (iOS-like inertia)
  useEffect(() => {
    if (!termReady || !termRef.current) return;

    const xtermScreen = termRef.current.element?.querySelector(".xterm-screen");
    if (!xtermScreen) return;

    let lastY = 0;
    let lastTime = 0;
    let velocity = 0;
    let momentumId = null;
    let accumulated = 0;

    const SENSITIVITY = 1.5;
    const LINE_HEIGHT = 14;
    const FRICTION = 0.95;
    const MIN_VELOCITY = 0.3;

    const stopMomentum = () => {
      if (momentumId) {
        cancelAnimationFrame(momentumId);
        momentumId = null;
      }
      velocity = 0;
    };
    stopMomentumRef.current = stopMomentum;

    const doMomentum = () => {
      if (!termRef.current || Math.abs(velocity) < MIN_VELOCITY) {
        momentumId = null;
        return;
      }

      accumulated += velocity;
      const lines = Math.trunc(accumulated / LINE_HEIGHT);
      if (lines !== 0) {
        termRef.current.scrollLines(lines);
        accumulated -= lines * LINE_HEIGHT;
      }

      velocity *= FRICTION;
      momentumId = requestAnimationFrame(doMomentum);
    };

    const handleTouchStart = (e) => {
      stopMomentum();
      lastY = e.touches[0].clientY;
      lastTime = Date.now();
      velocity = 0;
      accumulated = 0;
    };

    const handleTouchMove = (e) => {
      if (!termRef.current) return;

      const currentY = e.touches[0].clientY;
      const currentTime = Date.now();
      const deltaY = (lastY - currentY) * SENSITIVITY;
      const deltaTime = currentTime - lastTime || 1;

      accumulated += deltaY;
      const lines = Math.trunc(accumulated / LINE_HEIGHT);
      if (lines !== 0) {
        termRef.current.scrollLines(lines);
        accumulated -= lines * LINE_HEIGHT;
      }

      velocity = (deltaY / deltaTime) * 16;
      lastY = currentY;
      lastTime = currentTime;
    };

    const handleTouchEnd = () => {
      if (Math.abs(velocity) > MIN_VELOCITY) {
        momentumId = requestAnimationFrame(doMomentum);
      }
    };

    xtermScreen.addEventListener("touchstart", handleTouchStart, { passive: true });
    xtermScreen.addEventListener("touchmove", handleTouchMove, { passive: true });
    xtermScreen.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      stopMomentum();
      xtermScreen.removeEventListener("touchstart", handleTouchStart);
      xtermScreen.removeEventListener("touchmove", handleTouchMove);
      xtermScreen.removeEventListener("touchend", handleTouchEnd);
    };
  }, [termReady, isActive]);

  return {
    termRef,
    cwdRef, // Expose cwd for file path resolution
    doResize,
    focus: () => termRef.current?.focus(),
    stopMomentum: () => stopMomentumRef.current?.()
  };
}
