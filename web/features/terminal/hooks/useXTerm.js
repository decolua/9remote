"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { ImageAddon } from "@xterm/addon-image";
import { THEMES, resolveTerminalTheme } from "@/features/terminal/constants/themes";
import { termLog } from "@/shared/utils/termLog";
import { TERMINAL_OPTIONS, RENDERER, ADDONS, isUserTyping, MIN_COLS, MIN_ROWS, SETTLE_DEBOUNCE_MS, ORIENTATION_SETTLE_MS, RECONNECT_WARM_MS, HISTORY_FETCH } from "@/features/terminal/constants/terminalConfig";
import { resetReconnectState } from "@/features/terminal/lib/reconnectState";
import { createWriteBatcher } from "@/features/terminal/lib/termWriteBatcher";
import { createGapFetch } from "@/features/terminal/lib/gapFetch";
import { createJoinSession } from "@/features/terminal/lib/termJoin";
import { createOutputRouter } from "@/features/terminal/lib/termOutputRouter";
import { writeChunked } from "@/features/terminal/lib/historyMirror";
import { useTermTouchGestures } from "@/features/terminal/hooks/useTermTouchGestures";
import { useTerminalStore } from "@/shared/stores/terminalStore";

// isVisible: pane is shown (desktop: always true for opened panes, mobile: only active)
// isFocused: pane receives keyboard input (only one pane focused at a time)
export function useXTerm({ socket, sessionId, theme, terminalTheme, isVisible, isFocused, containerRef, mountDelay = 0, onInput, onSelectionMade }) {
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const writeBatcherRef = useRef(null);
  const webglAddonRef = useRef(null);
  const loadWebGLRef = useRef(null);
  const disposeWebGLRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const resizeTimerRef = useRef(null);
  const doResizeRef = useRef(null);
  const doJoinSessionRef = useRef(null); // reload() calls this — no full socket reconnect
  const fireJoinRef = useRef(null);      // emit joinSession at a size (set by doJoinSession, called by settle)
  const forceNextRef = useRef(false);   // doResize({force}) flag carried into the settle timer
  const joinNextRef = useRef(false);    // doResize({join}) flag — fire a deferred join at settled size
  const stopMomentumRef = useRef(null);
  const cwdRef = useRef(null); // Track current working directory
  const [cwd, setCwd] = useState(null); // Reactive cwd for toolbar UI
  const webglEnabled = useTerminalStore((s) => s.webglEnabled);
  const fontSizeSetting = useTerminalStore((s) => s.fontSize);
  const onSelectionMadeRef = useRef(onSelectionMade);
  useEffect(() => { onSelectionMadeRef.current = onSelectionMade; }, [onSelectionMade]);
  const awaitingTuiOutputRef = useRef(false); // SGR emit→output round-trip tracker (TUI backpressure)
  const searchAddonRef = useRef(null);
  const [termReady, setTermReady] = useState(false);

  // Last PTY size sent — skip emit when fit yields the same cols/rows (soft-KB with fixed pane height)
  const lastPtySizeRef = useRef(null);

  // Scrollback history mirror — raw bytes written to XTerm, so we can replay after
  // fetching an older prefix on scroll-up. have = bytes currently mirrored.
  const historyMirrorRef = useRef([]); // array of Uint8Array/string chunks
  const historyBytesRef = useRef(0);   // total mirrored bytes
  const historyTotalRef = useRef(0);   // bytes agent reports holding (ceiling)
  const historyFetchingRef = useRef(false); // in-flight requestHistory
  const historyLastFetchRef = useRef(0);    // timestamp of last fetch (guard)
  const historyHaveAtEmitRef = useRef(0);   // historyBytesRef snapshot at requestHistory emit (race-dedup)
  // Live-output seq (plan F): last live seq rendered. Detects a scrollback gap when output was
  // lost during a background suspension the warm-reconnect heuristic missed. null until the
  // first seq'd chunk arrives (old agents send no seq → seq logic stays disabled).
  const lastSeqRef = useRef(null);
  // Gap recovery (plan G) state machine — lives inside the main effect (closure)
  // Join-replay window: while a joinSession round-trip is in flight (emit → replay → ack), LIVE
  // output is QUEUED (not written) so it never lands between term.reset() and the mode-restore
  // replay packet. Queue + flush on ack: replay paints first, queued live follows in order.
  const joiningRef = useRef(false);
  const [joining, setJoining] = useState(false); // reactive for the loading spinner during join
  const joinQueueRef = useRef([]);
  const joinGenRef = useRef(0); // stale-ack guard: only the current join's ack clears the spinner
  const scrollDisposeRef = useRef(null);    // disposable from term.onScroll
  const needsRejoinRef = useRef(false);     // reconnect fired while pane hidden → defer rejoin until visible
  const isVisibleRef = useRef(isVisible);   // mirror isVisible for socket handlers
  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
  const [historyFetching, setHistoryFetching] = useState(false); // loading indicator state
  const maybeFetchHistoryRef = useRef(null); // shared with touch/wheel scroll handlers
  const userAtTopRef = useRef(false); // true only when the user actively scrolled up to top
  const lastOutputAtRef = useRef(0);  // ts of last live output — warm gate for reconnect skip
  const outputTotalRef = useRef(0);   // bytes received this session — dup detector

  // Emit resize only if cols/rows are above the sane-size floor. A transient tiny size
  // (layout mid-transition, app-resume reconnect) re-wraps scrollback narrow forever.
  const emitResize = useCallback(() => {
    const term = termRef.current;
    if (!term || !socket) return;
    const { cols, rows } = term;
    if (cols < MIN_COLS || rows < MIN_ROWS) return;
    lastPtySizeRef.current = { cols, rows };
    socket.emit("resize", { sessionId, cols, rows });
  }, [socket, sessionId]);

  // Settle-and-emit: single debounce (SETTLE_DEBOUNCE_MS) after the LAST layout change, then fit
  // once + emit at the settled size. PTY cols is one-way (a transient narrow cols re-wraps
  // scrollback narrow FOREVER) so we never accept a mid-transition size — the debounce IS the
  // stability gate, event-driven via ResizeObserver.
  // opts.force: always emit even if size unchanged (reconnect/redraw). opts.join: also fire the
  // deferred join at this size (initial mount / group switch).
  const doResize = useCallback((opts = {}) => {
    const force = opts === true || opts?.force === true;
    const join = !!opts?.join;
    if (force) forceNextRef.current = true;
    if (join) joinNextRef.current = true;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      const term = termRef.current;
      const fitAddon = fitAddonRef.current;
      const el = containerRef.current;
      if (!term || term._isDisposed || !fitAddon || !socket) return;
      if (!el?.offsetWidth || !el?.offsetHeight) return; // not laid out yet → RO will re-kick
      fitAddon.fit();
      const { cols, rows } = term;
      if (cols < MIN_COLS || rows < MIN_ROWS) return; // mid-transition → RO will re-kick
      const prev = lastPtySizeRef.current;
      const force = forceNextRef.current;
      const wantJoin = joinNextRef.current;
      forceNextRef.current = false;
      joinNextRef.current = false;
      if (!force && prev && prev.cols === cols && prev.rows === rows && !wantJoin) return;
      lastPtySizeRef.current = { cols, rows };
      socket.emit("resize", { sessionId, cols, rows });
      if (wantJoin && fireJoinRef.current) {
        term.reset();
        fireJoinRef.current(cols, rows);
      }
    }, SETTLE_DEBOUNCE_MS);
  }, [socket, sessionId, containerRef]);

  useEffect(() => { doResizeRef.current = doResize; }, [doResize]);

  // Initialize XTerm instance
  useEffect(() => {
    if (!containerRef.current || !socket || !sessionId) return;
    if (termRef.current) return;

    // Fresh session → no prior output; clear so a carrier switch right after join
    // can't reuse a stale warm timestamp from the previous session.
    lastOutputAtRef.current = 0;
    // Seq is per-session and starts over — a leftover value from the previous session
    // would classify this session's first chunk as a huge false gap.
    lastSeqRef.current = null;

    const term = new XTerm({
      ...TERMINAL_OPTIONS,
      fontSize: fontSizeSetting ?? (window.innerWidth < 768 ? TERMINAL_OPTIONS.fontSizeMobile : TERMINAL_OPTIONS.fontSize),
      theme: resolveTerminalTheme(theme, terminalTheme) || THEMES.dark
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Unicode v11 width tables fix CJK/combining glyph misalignment on mobile
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.open(containerRef.current);

    // rAF write batcher — coalesce high-frequency output bursts into one write/frame so the
    // main thread isn't blocked parsing/rendering each 1KB chunk.
    const batcher = createWriteBatcher(term);
    writeBatcherRef.current = batcher;

    if (ADDONS.search) {
      searchAddonRef.current = new SearchAddon();
      term.loadAddon(searchAddonRef.current);
    }

    // Smooth scroll only for physical mouse wheel (VS Code parity); touch keeps inertia handler
    const wheelEl = containerRef.current;
    const handleWheel = (e) => {
      term.options.smoothScrollDuration = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50
        ? RENDERER.smoothScrollDuration : 0;
    };
    wheelEl.addEventListener("wheel", handleWheel, { passive: true });

    // WebGL renderer (VS Code parity: WebGL → DOM fallback). Loaded after joinSession to avoid a blank screen.
    let webglAddon = null;
    let webglFailed = false;
    const loadWebGL = () => {
      if (webglAddon || webglFailed || RENDERER.gpuAcceleration === "off") return;
      try {
        webglAddon = new WebglAddon();
        // Context loss (GPU reclaimed) → dispose, xterm auto falls back to DOM. Buffer text preserved.
        webglAddon.onContextLoss(() => {
          webglAddon?.dispose();
          webglAddon = null;
        });
        term.loadAddon(webglAddon);
        // Image addon only with WebGL active (VS Code parity, avoids GPU issues)
        if (ADDONS.image) term.loadAddon(new ImageAddon());
        // WebGL cell dimensions differ from DOM → re-fit after load
        fitAddon.fit();
      } catch (e) {
        webglFailed = true;
        webglAddon = null;
        console.warn("WebGL unavailable, using DOM renderer");
      }
    };
    const disposeWebGL = () => {
      if (!webglAddonRef.current) return;
      webglAddonRef.current.dispose();
      webglAddonRef.current = null;
      fitAddon.fit();
      emitResize();
      term.refresh(0, term.rows - 1);
    };

    loadWebGLRef.current = loadWebGL;
    disposeWebGLRef.current = disposeWebGL;

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

      if (term.element && width >= 100 && height >= 100) {
        fitAddon.fit();
        emitResize();
        setTermReady(true);
      } else {
        setTimeout(checkReady, 50);
      }
    };
    setTimeout(checkReady, 50);

    const resizeObserver = new ResizeObserver(() => doResizeRef.current?.());
    resizeObserver.observe(containerRef.current);

    // Detect scroll near top (primary buffer only) → fetch an older history chunk from the agent.
    const maybeFetchHistory = () => {
      const buf = term.buffer.active;
      if (HISTORY_FETCH.disabled) return;
      if (historyFetchingRef.current) return;
      if (buf.type === "alternate") return;
      if (historyTotalRef.current <= 0) return;
      // Skip when fewer than minFetchBytes remain — a few stray bytes (live output that landed
      // between fetches) aren't worth a full mirror reset+rewrite, which yanks the viewport.
      if (historyTotalRef.current - historyBytesRef.current < HISTORY_FETCH.minFetchBytes) return;
      const now = Date.now();
      if (now - historyLastFetchRef.current < HISTORY_FETCH.guardMs) return;
      // Only fetch when the user actively scrolled to top — viewportY is transiently 0 right
      // after mount/write, so relying on it alone would fire a fetch on every F5.
      if (!userAtTopRef.current) return;
      if (buf.viewportY > HISTORY_FETCH.topThresholdLines) { userAtTopRef.current = false; return; }

      historyFetchingRef.current = true;
      historyLastFetchRef.current = now;
      historyHaveAtEmitRef.current = historyBytesRef.current;
      setHistoryFetching(true);
      socket.emit("requestHistory", { sessionId, have: historyHaveAtEmitRef.current }, (result) => {
        if (!result || !result.success) { historyFetchingRef.current = false; setHistoryFetching(false); return; }
        if (!result.prefixLen) { historyFetchingRef.current = false; setHistoryFetching(false); }
        historyTotalRef.current = result.total || historyTotalRef.current;
      });
    };
    scrollDisposeRef.current = term.onScroll(maybeFetchHistory);
    term.textarea?.addEventListener("keyup", maybeFetchHistory);
    maybeFetchHistoryRef.current = maybeFetchHistory;

    // Gap-recovery state machine (plan G): request a missing live-output range and append it —
    // no reset, no flash. Live output meanwhile is queued, then flushed after the gap.
    const gapFetch = createGapFetch({
      emit: (payload, ack) => socket.emit("requestGap", { sessionId, ...payload }, ack),
      writeChunk: (data) => {
        const b = writeBatcherRef.current;
        writeChunked(term, data, historyMirrorRef, historyBytesRef, b);
        b?.flush();
      },
      flush: () => writeBatcherRef.current?.flush(),
      onGapChunk: (seq) => { lastSeqRef.current = seq; },
      onFallback: () => {
        if (termRef.current) termRef.current.reset();
        doJoinSessionRef.current?.(true);
      },
      log: (msg) => termLog("reconnect", msg),
      getFromSeq: () => (lastSeqRef.current ?? 0) + 1
    });

    /** On becoming visible, ASK the agent for its newest seq instead of waiting for the next
     *  chunk — output produced while backgrounded otherwise stays missing until the terminal
     *  prints again (a finished command leaves the pane silently truncated). */
    const checkSeqOnVisible = () => {
      if (!isVisibleRef.current) return;        // pane is LRU-hidden (other group) — don't recover into a zero-size buffer
      if (lastSeqRef.current == null) return;   // no seq baseline yet (old agent / fresh pane)
      if (joiningRef.current || gapFetch.isBusy()) return; // recovery already running
      socket.emit("peekSeq", { sessionId }, (res) => {
        const agentSeq = res?.seq;
        if (agentSeq == null) return;           // agent too old to answer → warm path handles it
        if (agentSeq <= (lastSeqRef.current ?? 0)) return; // nothing missed
        termLog("reconnect", `peekSeq ${lastSeqRef.current} → ${agentSeq} → recover`);
        gapFetch.start(agentSeq);
      });
    };

    // Output routing: prefix replay / join replay / gap / queues / seq classify / live
    const { handleOutput } = createOutputRouter({
      sessionId, term, writeBatcherRef, gapFetch,
      refs: {
        joiningRef, joinQueueRef, lastSeqRef, lastOutputAtRef, outputTotalRef,
        awaitingTuiOutputRef, userAtTopRef, historyFetchingRef, historyHaveAtEmitRef,
        historyMirrorRef, historyBytesRef
      },
      setHistoryFetching
    });
    socket.on("output", handleOutput);

    // Server-pushed cwd change (OSC 7 detected daemon-side) — authoritative cwd source
    const handleCwdChange = (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      if (payload.cwd) { cwdRef.current = payload.cwd; setCwd(payload.cwd); useTerminalStore.getState().setCwd(sessionId, payload.cwd); }
    };
    socket.on("cwdChange", handleCwdChange);

    // Join session and replay scrollback buffer from the daemon
    const doJoinSession = createJoinSession({
      socket, sessionId, term, fitAddon, writeBatcherRef, doResizeRef, fireJoinRef,
      refs: {
        historyMirrorRef, historyBytesRef, historyTotalRef, historyFetchingRef,
        userAtTopRef, joiningRef, joinQueueRef, joinGenRef, lastSeqRef, cwdRef, setJoining
      },
      setCwd
    });
    // Stagger initial join by mountDelay so a freshly-entered group's panes don't all join at
    // once (focus pane = 0ms, siblings stagger ~120ms). Rejoins pass 0.
    if (mountDelay > 0) {
      const id = setTimeout(doJoinSession, mountDelay);
      doJoinSessionRef.current = doJoinSession;
      return () => clearTimeout(id); // unmount before fire → cancel
    }
    doJoinSession();
    doJoinSessionRef.current = doJoinSession;

    // On reconnect → clear stale content and rejoin to get the latest scrollback.
    // Only if the pane is visible — a hidden pane (different group, LRU) has a stale/zero-size
    // container; fitting+joining now would serialize the TUI snapshot at a wrong cols.
    const handleReconnect = () => {
      if (!termRef.current) return;
      // Reset transient state stuck from the disconnect (mid-flight requestHistory, mid-SGR
      // TUI round-trip). R5/R6 (join window, gap fetch) handled below and via gapFetch.cancel().
      resetReconnectState({
        historyFetching: historyFetchingRef,
        historyHaveAtEmit: historyHaveAtEmitRef,
        awaitingTuiOutput: awaitingTuiOutputRef,
        joining: joiningRef,
        joinQueue: joinQueueRef,
      });
      gapFetch.cancel();
      setHistoryFetching(false);
      setJoining(false); // rejoin below will set it true again on emit
      if (!isVisibleRef.current) { needsRejoinRef.current = true; termLog("reconnect", "deferred (pane hidden) → needsRejoin=true"); return; }
      // Warm reconnect: live output arrived recently → agent still streaming over the new
      // carrier, no scrollback gap. Skip reset+rejoin (which clears xterm = white flash) and
      // let output continue. Don't skip mid-join: the in-flight join's replay packets write on
      // the current buffer and would duplicate without the reset.
      const sinceOutput = Date.now() - lastOutputAtRef.current;
      if (!joiningRef.current && sinceOutput < RECONNECT_WARM_MS) {
        termLog("reconnect", `warm skip (${sinceOutput}ms < ${RECONNECT_WARM_MS})`);
        return;
      }
      termLog("reconnect", `reset+rejoin (sinceOutput=${sinceOutput}ms joining=${joiningRef.current})`);
      termRef.current.reset();
      doJoinSession(true);
    };
    socket.on("connect", handleReconnect);

    // Orientation change: wait for mobile layout to settle, then force-refit + re-emit cols.
    // RO may not fire or fire mid-transition with a stale width → cols lock to the wrong value.
    const handleOrientationChange = () => setTimeout(() => {
      const term = termRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || term._isDisposed || !fitAddon) return;
      fitAddon.fit();
      fitAddon.fit();
      doResizeRef.current?.({ force: true });
    }, ORIENTATION_SETTLE_MS);
    window.addEventListener("orientationchange", handleOrientationChange);

    // Force redraw when the tab becomes visible again (WebGL may not repaint after a tab
    // switch), and ask the agent for its newest seq to recover backgrounded output.
    const handleVisibilityChange = () => {
      if (!document.hidden && termRef.current) {
        termRef.current.refresh(0, termRef.current.rows - 1);
        checkSeqOnVisible();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("orientationchange", handleOrientationChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver.disconnect();
      wheelEl.removeEventListener("wheel", handleWheel);
      socket.off("connect", handleReconnect);
      socket.off("output", handleOutput);
      socket.off("cwdChange", handleCwdChange);
      if (scrollDisposeRef.current) scrollDisposeRef.current.dispose();
      term.textarea?.removeEventListener("keyup", maybeFetchHistory);
      if (inputHandlerRef.current) inputHandlerRef.current.dispose();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      // Gap fetch in flight → kill its fallback timer, else it fires after unmount
      gapFetch.cancel();
      if (webglAddonRef.current) webglAddonRef.current.dispose();
      if (writeBatcherRef.current) writeBatcherRef.current.dispose();
      fitAddon.dispose();
      term.dispose();
      termRef.current = null;
      setTermReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, sessionId]);

  // Live WebGL toggle: swap renderer + re-fit on change (no reload needed)
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !socket || !sessionId) return;
    if (webglEnabled) loadWebGLRef.current?.();
    else disposeWebGLRef.current?.();
  }, [webglEnabled, socket, sessionId]);

  // Live font size: apply + re-fit on change
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !socket || !sessionId) return;
    if (fontSizeSetting == null) return;
    term.options.fontSize = fontSizeSetting;
    fitAddon.fit();
    emitResize();
    term.refresh(0, term.rows - 1);
  }, [fontSizeSetting, socket, sessionId, emitResize]);

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

  // Hover scroll: forward mouse-report sequences to the PTY even when the pane is not focused,
  // so alt-screen apps (Claude Code CLI) scroll on hover without stealing keyboard focus.
  useEffect(() => {
    if (!termRef.current || !socket || !sessionId || isFocused) return;
    // Mouse SGR (\x1b[<) or normal (\x1b[M) report → forward; ignore keyboard data
    const isMouseReport = (d) => d.startsWith("\x1b[<") || d.startsWith("\x1b[M");
    const handler = termRef.current.onData((data) => {
      if (isMouseReport(data)) socket.emit("input", { sessionId, data });
    });
    return () => handler.dispose();
  }, [isFocused, socket, sessionId]);

  // Re-fit when becoming visible (desktop: all opened panes; mobile: active pane)
  useEffect(() => {
    if (!isVisible || !fitAddonRef.current || !termRef.current) return;
    const timer = setTimeout(() => {
      // Reconnect fired while this pane was hidden → snapshot was never fetched at the right
      // size. Now visible: reset + rejoin so the daemon serializes at the correct cols.
      if (needsRejoinRef.current) {
        needsRejoinRef.current = false;
        termLog("join", "deferred needsRejoin → fire (pane now visible)");
        termRef.current.reset();
        doJoinSessionRef.current?.(true);
        return;
      }
      // force: pane may have been hidden during reconnect → daemon snapshot stale, and
      // cols/rows unchanged would skip emit → PTY never gets SIGWINCH to redraw.
      doResize({ force: true });
      // Pane was hidden (LRU opacity-0) → force repaint so the stale canvas redraws
      requestAnimationFrame(() => termRef.current?.refresh(0, termRef.current.rows - 1));
    }, 100);
    return () => clearTimeout(timer);
  }, [isVisible, doResize]);

  // Refit when the pane receives focus (desktop split + mobile active pane).
  // Mobile single-pane: force PTY emit so the TUI redraws at the right size.
  useEffect(() => {
    if (!isFocused) return;
    const mobile = typeof window !== "undefined" && window.innerWidth < 760;
    const timer = setTimeout(() => {
      doResize(mobile ? { force: true } : undefined);
      requestAnimationFrame(() => termRef.current?.refresh(0, termRef.current.rows - 1));
    }, 100);
    return () => clearTimeout(timer);
  }, [isFocused, doResize]);

  // Update theme (app mode + sub-theme)
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = resolveTerminalTheme(theme, terminalTheme) || THEMES.dark;
    }
  }, [theme, terminalTheme]);

  useTermTouchGestures({
    termRef, termReady, isVisible, socket, sessionId,
    onSelectionMadeRef, awaitingTuiOutputRef, maybeFetchHistoryRef, userAtTopRef,
    stopMomentumRef
  });

  // Manual per-pane reload: reset the local XTerm + re-join THIS session to re-fetch the
  // scrollback tail + restore modes, then rebuild WebGL to clear glyph glitches. No socket
  // reconnect, no impact on other panes.
  const reload = useCallback(() => {
    const term = termRef.current;
    if (!term || !socket) return;
    termLog("join", "manual reload (user refetch)");
    term.reset();
    doJoinSessionRef.current?.(true);
    if (webglEnabled) {
      disposeWebGLRef.current?.();
      loadWebGLRef.current?.();
    } else {
      term.refresh(0, term.rows - 1);
    }
  }, [socket, webglEnabled]);

  return {
    termRef,
    cwdRef, // Expose cwd for file path resolution
    cwd, // Reactive cwd for toolbar UI
    searchAddonRef, // Expose for search UI (findNext/findPrevious)
    termReady,
    joining, // true while joinSession round-trip is in flight (initial mount + reconnect)
    doResize,
    reload,
    focus: () => termRef.current?.focus(),
    stopMomentum: () => stopMomentumRef.current?.(),
    historyFetching // true while an older-history chunk is in flight
  };
}
