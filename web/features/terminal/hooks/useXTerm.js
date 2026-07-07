"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { THEMES } from "@/features/terminal/constants/themes";
import { vibrate } from "@/shared/utils/vibration";
import { TERMINAL_OPTIONS, isUserTyping, TOUCH_SCROLL, TOUCH_SELECT } from "@/features/terminal/constants/terminalConfig";
import { detectLinks } from "@/features/terminal/utils/linkDetector";

// XTerm instance management hook
// isVisible: pane is shown (desktop: always true for opened panes, mobile: only active)
// isFocused: pane receives keyboard input (only one pane focused at a time)
export function useXTerm({ socket, sessionId, theme, isVisible, isFocused, containerRef, onInput, onSelectionMade }) {
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const resizeTimerRef = useRef(null);
  const doResizeRef = useRef(null);
  const stopMomentumRef = useRef(null);
  const cwdRef = useRef(null); // Track current working directory
  const decoderRef = useRef(null); // Reused TextDecoder for binary output
  const onSelectionMadeRef = useRef(onSelectionMade);
  useEffect(() => { onSelectionMadeRef.current = onSelectionMade; }, [onSelectionMade]);
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
  useEffect(() => { doResizeRef.current = doResize; }, [doResize]);

  // Initialize XTerm instance
  useEffect(() => {
    if (!containerRef.current || !socket || !sessionId) return;
    if (termRef.current) return;

    const term = new XTerm({
      ...TERMINAL_OPTIONS,
      fontSize: window.innerWidth < 768 ? TERMINAL_OPTIONS.fontSizeMobile : TERMINAL_OPTIONS.fontSize,
      theme: THEMES[theme] || THEMES.dark
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Unicode v11 width tables fix CJK/combining glyph misalignment on mobile
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.open(containerRef.current);

    // File/URL link provider: detect per-line, xterm handles highlight + click
    term.registerLinkProvider({
      provideLinks: (bufferLineNumber, cb) => {
        const buffer = term.buffer.active;
        const line = buffer.getLine(bufferLineNumber - 1);
        if (!line) { cb([]); return; }
        const links = detectLinks(line.translateToString(true), bufferLineNumber, cwdRef.current);
        cb(links.map((l) => ({ range: l.range, activate: l.activate })));
      },
    });

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
        const text = typeof data === "string" ? data : (decoderRef.current ??= new TextDecoder()).decode(data);
        // Gate OSC7 scan — skip regex unless an escape sequence is present
        const osc7Match = text.indexOf("\x1b") !== -1 ? text.match(/\x1b\]7;file:\/\/[^\/]*(.+?)\x07/) : null;
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
            // Temporary: disable WebGL renderer for blurry-text verification on mobile devices.
            // loadWebGL();
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

    if (isFocused) {
      inputHandlerRef.current = termRef.current.onData((data) => {
        if (isUserTyping(data)) onInput?.(sessionId);
        socket.emit("input", { sessionId, data });
      });
    }
  }, [isFocused, socket, sessionId, onInput]);

  // Re-fit when becoming visible (desktop: all opened panes; mobile: active pane)
  useEffect(() => {
    if (!isVisible || !fitAddonRef.current || !termRef.current) return;
    const timer = setTimeout(doResize, 100);
    return () => clearTimeout(timer);
  }, [isVisible, doResize]);

  // Refit terminal when pane receives focus (desktop split + mobile active pane)
  useEffect(() => {
    if (!isFocused) return;
    const timer = setTimeout(doResize, 100);
    return () => clearTimeout(timer);
  }, [isFocused, doResize]);

  // Update theme
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = THEMES[theme] || THEMES.dark;
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

    const SENSITIVITY = TOUCH_SCROLL.sensitivity;
    const LINE_HEIGHT = TOUCH_SCROLL.lineHeight;
    const FRICTION = TOUCH_SCROLL.friction;
    const MIN_VELOCITY = TOUCH_SCROLL.minVelocity;

    // Alt-buffer (TUI mouse-tracking) has no scrollback → send SGR wheel to app; else scroll local scrollback
    const applyScroll = (lines) => {
      const t = termRef.current;
      if (!t) return;
      if (t.buffer.active.type === "alternate") {
        const x = Math.max(1, Math.ceil(t.cols / 2));
        const y = Math.max(1, Math.ceil(t.rows / 2));
        const seq = lines > 0 ? TOUCH_SCROLL.sgrDown(x, y) : TOUCH_SCROLL.sgrUp(x, y);
        const n = Math.min(Math.abs(lines), TOUCH_SCROLL.wheelStepLines);
        for (let i = 0; i < n; i++) socket.emit("input", { sessionId, data: seq });
      } else {
        t.scrollLines(lines);
      }
    };

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
        applyScroll(lines);
        accumulated -= lines * LINE_HEIGHT;
      }

      velocity *= FRICTION;
      momentumId = requestAnimationFrame(doMomentum);
    };

    // --- Long-press text selection (mobile) ---
    let longPressTimer = null;
    let selecting = false;
    let selStart = null; // {col, row} absolute buffer coords
    let startX = 0, startY = 0, curX = 0, curY = 0, moved = false;

    // Cached during select drag so touchToCell skips getBoundingClientRect() per frame (avoids reflow)
    let selRect = null;

    // Map viewport pixel → absolute buffer cell (accounts for scrollback offset).
    const touchToCell = (clientX, clientY) => {
      const t = termRef.current;
      const rect = selRect || xtermScreen.getBoundingClientRect();
      const cellW = rect.width / t.cols;
      const cellH = rect.height / t.rows;
      const col = Math.max(0, Math.min(t.cols - 1, Math.floor((clientX - rect.left) / cellW)));
      const vRow = Math.max(0, Math.min(t.rows - 1, Math.floor((clientY - rect.top) / cellH)));
      return { col, row: t.buffer.active.viewportY + vRow };
    };

    const selectWordAt = ({ col, row }) => {
      const t = termRef.current;
      const line = t.buffer.active.getLine(row);
      if (!line) return;
      const text = line.translateToString(false);
      const isWord = (c) => c && TOUCH_SELECT.wordChars.test(c);
      if (!isWord(text[col])) { t.select(col, row, 1); return; }
      let start = col, end = col;
      while (start > 0 && isWord(text[start - 1])) start--;
      while (end < text.length - 1 && isWord(text[end + 1])) end++;
      t.select(start, row, end - start + 1);
    };

    const extendSelection = (cell) => {
      const t = termRef.current;
      if (cell.row === selStart.row) {
        const min = Math.min(cell.col, selStart.col);
        t.select(min, cell.row, Math.abs(cell.col - selStart.col) + 1);
      } else {
        t.selectLines(Math.min(cell.row, selStart.row), Math.max(cell.row, selStart.row));
      }
    };

    const handleTouchStart = (e) => {
      stopMomentum();
      const touch = e.touches[0];
      lastY = touch.clientY;
      startX = curX = touch.clientX;
      startY = curY = touch.clientY;
      lastTime = Date.now();
      velocity = 0;
      accumulated = 0;
      selecting = false;
      moved = false;
      termRef.current?.clearSelection();
      longPressTimer = setTimeout(() => {
        if (moved || !termRef.current) return;
        selecting = true;
        vibrate();
        selRect = xtermScreen.getBoundingClientRect();
        selStart = touchToCell(startX, startY);
        selectWordAt(selStart);
      }, TOUCH_SELECT.longPressMs);
    };

    const handleTouchMove = (e) => {
      if (!termRef.current) return;
      const touch = e.touches[0];
      curX = touch.clientX;
      curY = touch.clientY;

      if (!moved && Math.hypot(curX - startX, curY - startY) > TOUCH_SELECT.moveTolerance) {
        moved = true;
        if (!selecting) clearTimeout(longPressTimer); // it's a scroll, not a long-press
      }

      if (selecting) {
        e.preventDefault();
        extendSelection(touchToCell(curX, curY));
        return;
      }

      const currentY = touch.clientY;
      const currentTime = Date.now();
      const deltaY = (lastY - currentY) * SENSITIVITY;
      const deltaTime = currentTime - lastTime || 1;

      accumulated += deltaY;
      const lines = Math.trunc(accumulated / LINE_HEIGHT);
      if (lines !== 0) {
        applyScroll(lines);
        accumulated -= lines * LINE_HEIGHT;
      }

      velocity = (deltaY / deltaTime) * 16;
      lastY = currentY;
      lastTime = currentTime;
    };

    const handleTouchEnd = () => {
      clearTimeout(longPressTimer);
      selRect = null;
      if (selecting) {
        selecting = false;
        const sel = termRef.current?.getSelection();
        if (sel && sel.trim()) onSelectionMadeRef.current?.(sel, { x: curX, y: curY });
        return;
      }
      if (Math.abs(velocity) > MIN_VELOCITY) {
        momentumId = requestAnimationFrame(doMomentum);
      }
    };

    xtermScreen.addEventListener("touchstart", handleTouchStart, { passive: true });
    xtermScreen.addEventListener("touchmove", handleTouchMove, { passive: false });
    xtermScreen.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      stopMomentum();
      clearTimeout(longPressTimer);
      xtermScreen.removeEventListener("touchstart", handleTouchStart);
      xtermScreen.removeEventListener("touchmove", handleTouchMove);
      xtermScreen.removeEventListener("touchend", handleTouchEnd);
    };
  }, [termReady, isVisible]);

  return {
    termRef,
    cwdRef, // Expose cwd for file path resolution
    termReady,
    doResize,
    focus: () => termRef.current?.focus(),
    stopMomentum: () => stopMomentumRef.current?.()
  };
}
