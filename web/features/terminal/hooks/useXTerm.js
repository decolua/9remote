"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { THEMES } from "@/features/terminal/constants/themes";
import { vibrate } from "@/shared/utils/vibration";
import { TERMINAL_OPTIONS, isUserTyping, TOUCH_SCROLL, TOUCH_SELECT } from "@/features/terminal/constants/terminalConfig";
import { useTerminalStore } from "@/shared/stores/terminalStore";
// import { detectLinks } from "@/features/terminal/utils/linkDetector";

// Write output directly — xterm ANSI parse is cheap (~3ms/MB); chunking via rAF only adds latency.
function writeChunked(term, data) {
  if (!term || term._core?._isDisposed) return;
  term.write(data);
}

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
  const [cwd, setCwd] = useState(null); // Reactive cwd for toolbar UI
  const onSelectionMadeRef = useRef(onSelectionMade);
  useEffect(() => { onSelectionMadeRef.current = onSelectionMade; }, [onSelectionMade]);
  const awaitingTuiOutputRef = useRef(false); // SGR emit→output round-trip tracker (TUI backpressure)
  const [termReady, setTermReady] = useState(false);

  // Last PTY size sent — skip emit when fit yields same cols/rows (soft-KB with fixed pane height)
  const lastPtySizeRef = useRef(null);

  // Resize with debounce singleton - uses rAF to ensure layout is stable
  // Always re-fit canvas; skip PTY emit only when size unchanged AND not forced (soft-KB/tab dup guard).
  const doResize = useCallback((opts = {}) => {
    const force = opts === true || opts?.force === true;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      requestAnimationFrame(() => {
        if (!fitAddonRef.current || !termRef.current || !socket) return;
        const el = containerRef.current;
        if (!el?.offsetWidth || !el?.offsetHeight) {
          resizeTimerRef.current = null;
          return;
        }
        fitAddonRef.current.fit();
        const { cols, rows } = termRef.current;
        const prev = lastPtySizeRef.current;
        if (!force && prev && prev.cols === cols && prev.rows === rows) {
          resizeTimerRef.current = null;
          return;
        }
        lastPtySizeRef.current = { cols, rows };
        socket.emit("resize", { sessionId, cols, rows });
        resizeTimerRef.current = null;
      });
    }, 150);
  }, [socket, sessionId, containerRef]);

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

    // File/URL link provider: temporarily disabled (inaccurate resolve), re-enable later
    // term.registerLinkProvider({
    //   provideLinks: (bufferLineNumber, cb) => {
    //     const buffer = term.buffer.active;
    //     const line = buffer.getLine(bufferLineNumber - 1);
    //     if (!line) { cb([]); return; }
    //     const links = detectLinks(line.translateToString(true), bufferLineNumber, cwdRef.current);
    //     cb(links.map((l) => ({ range: l.range, activate: l.activate })));
    //   },
    // });

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
      awaitingTuiOutputRef.current = false; // SGR round-trip done → resume TUI scroll

      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        writeChunked(term, data instanceof Uint8Array ? data : new Uint8Array(data));
      } else if (typeof data === "string") {
        writeChunked(term, data);
      } else {
        writeChunked(term, String(data));
      }
    };
    socket.on("output", handleOutput);

    // Server-pushed cwd change (OSC 7 detected daemon-side) — authoritative cwd source
    const handleCwdChange = (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      if (payload.cwd) { cwdRef.current = payload.cwd; setCwd(payload.cwd); useTerminalStore.getState().setCwd(sessionId, payload.cwd); }
    };
    socket.on("cwdChange", handleCwdChange);

    // Join session and replay scrollback buffer from daemon
    const doJoinSession = (isRejoin = false) => {
      socket.emit("joinSession", sessionId, (result) => {
        if (result.success) {
          if (result.cwd) { cwdRef.current = result.cwd; setCwd(result.cwd); useTerminalStore.getState().setCwd(sessionId, result.cwd); }
          setTimeout(() => {
            // Temporary: disable WebGL renderer for blurry-text verification on mobile devices.
            // loadWebGL();
            fitAddon.fit();
          }, 200);
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
      socket.off("cwdChange", handleCwdChange);
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
    const timer = setTimeout(() => {
      doResize();
      // Pane was hidden (LRU opacity-0) → force repaint so stale canvas redraws even at same size
      requestAnimationFrame(() => termRef.current?.refresh(0, termRef.current.rows - 1));
    }, 100);
    return () => clearTimeout(timer);
  }, [isVisible, doResize]);

  // Refit terminal when pane receives focus (desktop split + mobile active pane)
  // Mobile single-pane: force PTY emit so TUI redraws at the right size (no split size change to trigger it)
  useEffect(() => {
    if (!isFocused) return;
    const mobile = typeof window !== "undefined" && window.innerWidth < 760;
    const timer = setTimeout(() => {
      doResize(mobile ? { force: true } : undefined);
      requestAnimationFrame(() => termRef.current?.refresh(0, termRef.current.rows - 1));
    }, 100);
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
    let lastScrollAt = 0;

    const SENSITIVITY = TOUCH_SCROLL.sensitivity;
    const FALLBACK_LINE_HEIGHT = TOUCH_SCROLL.lineHeight;
    const LINE_HEIGHT = TOUCH_SCROLL.lineHeight;
    const FRICTION = TOUCH_SCROLL.friction;
    const MIN_VELOCITY = TOUCH_SCROLL.minVelocity;
    const MAX_VELOCITY = TOUCH_SCROLL.maxVelocity;
    const TUI_THROTTLE_MS = TOUCH_SCROLL.tuiThrottleMs;
    const MOMENTUM_CADENCE_MS = TOUCH_SCROLL.momentumRenderCadenceMs;
    const TUI_BACKPRESSURE_TIMEOUT_MS = TOUCH_SCROLL.tuiBackpressureTimeoutMs;
    const MAX_LINES_PER_FRAME = 3; // cap scrollLines per frame → smaller repaints, smoother inertia

    // Throttle SGR wheel burst so touch ≈ PC wheel cadence (TUI decides actual rate).
    let lastSgrAt = 0;
    let pendingLines = 0;
    let pendingTimer = null;
    const flushSgr = () => {
      pendingTimer = null;
      if (!pendingLines) return;
      const t = termRef.current;
      if (!t) { pendingLines = 0; return; }
      const x = Math.max(1, Math.ceil(t.cols / 2));
      const y = Math.max(1, Math.ceil(t.rows / 2));
      const seq = pendingLines > 0 ? TOUCH_SCROLL.sgrDown(x, y) : TOUCH_SCROLL.sgrUp(x, y);
      const n = Math.min(Math.abs(pendingLines), TOUCH_SCROLL.wheelStepLines);
      for (let i = 0; i < n; i++) socket.emit("input", { sessionId, data: seq });
      pendingLines = 0;
      lastSgrAt = performance.now();
      awaitingTuiOutputRef.current = true; // expect output round-trip; cleared in handleOutput
    };

    // Alt-buffer (TUI mouse-tracking) has no scrollback → send SGR wheel to app; else scroll local scrollback
    const applyScroll = (lines) => {
      const t = termRef.current;
      if (!t) return;
      if (t.buffer.active.type === "alternate") {
        // Backpressure: TUI still redrawing last SGR → drop new lines, don't pile up.
        // Safety timeout: clear anyway after TUI_BACKPRESSURE_TIMEOUT_MS so TUIs that
        // don't emit output on wheel (opencode/lazygit) never stall scroll.
        if (awaitingTuiOutputRef.current && performance.now() - lastSgrAt < TUI_BACKPRESSURE_TIMEOUT_MS) return;
        pendingLines += lines;
        const elapsed = performance.now() - lastSgrAt;
        if (elapsed >= TUI_THROTTLE_MS) {
          flushSgr();
        } else if (!pendingTimer) {
          pendingTimer = setTimeout(flushSgr, TUI_THROTTLE_MS - elapsed);
        }
      } else {
        t.scrollLines(Math.max(-MAX_LINES_PER_FRAME, Math.min(MAX_LINES_PER_FRAME, lines)));
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

      const isAlt = termRef.current.buffer?.active?.type === "alternate";
      const now = performance.now();
      // Decay velocity every frame consistently — gates below only control apply, not decay
      velocity *= FRICTION;

      // TUI backpressure (RTT-aware, with timeout safety for non-responsive TUIs)
      const tuiBusy = isAlt && awaitingTuiOutputRef.current && now - lastSgrAt < TUI_BACKPRESSURE_TIMEOUT_MS;
      // Scrollback render cadence: cap repaint to ~30fps during inertia
      const cadenceDue = !isAlt && now - lastScrollAt >= MOMENTUM_CADENCE_MS;

      if (!tuiBusy && (isAlt || cadenceDue)) {
        accumulated += velocity;
        const lines = Math.trunc(accumulated / LINE_HEIGHT);
        if (lines !== 0) {
          applyScroll(lines);
          accumulated -= lines * LINE_HEIGHT;
          lastScrollAt = performance.now();
        }
      }

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
      const dy = lastY - currentY; // >0 finger up / reveal bottom; <0 finger down / reveal top
      const deltaTime = currentTime - lastTime || 1;

      // Soft-KB: pan outer wrapper first; at edge hand off to xterm scrollback
      const wrap = xtermScreen.closest(".terminal-scroll.is-scrollable");
      if (wrap && wrap.scrollHeight > wrap.clientHeight + 1) {
        const maxScroll = wrap.scrollHeight - wrap.clientHeight;
        const atTop = wrap.scrollTop <= 0.5;
        const atBottom = wrap.scrollTop >= maxScroll - 0.5;
        // Still room in wrapper → scroll it; at top+up or bottom+down → xterm
        const handoffToTerm = (dy < 0 && atTop) || (dy > 0 && atBottom);
        if (!handoffToTerm) {
          if (dy !== 0) {
            e.preventDefault();
            wrap.scrollTop = Math.max(0, Math.min(maxScroll, wrap.scrollTop + dy));
          }
          lastY = currentY;
          lastTime = currentTime;
          velocity = 0;
          accumulated = 0;
          return;
        }
        // fall through to xterm applyScroll
      }

      const deltaY = dy * SENSITIVITY;
      accumulated += deltaY;
      const lines = Math.trunc(accumulated / LINE_HEIGHT);
      if (lines !== 0) {
        e.preventDefault();
        applyScroll(lines);
        accumulated -= lines * LINE_HEIGHT;
      }

      velocity = Math.min((deltaY / deltaTime) * 16, MAX_VELOCITY);
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
    cwd, // Reactive cwd for toolbar UI
    termReady,
    doResize,
    focus: () => termRef.current?.focus(),
    stopMomentum: () => stopMomentumRef.current?.()
  };
}
