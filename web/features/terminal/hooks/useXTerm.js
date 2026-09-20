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
import { TERMINAL_OPTIONS, RENDERER, ADDONS, isUserTyping, isTerminalReport, MIN_COLS, MIN_ROWS, SETTLE_DEBOUNCE_MS, ORIENTATION_SETTLE_MS, RECOVER_DEBOUNCE_MS, PEEK_TIMEOUT_MS, HISTORY_FETCH, applyTerminalBackground, effectiveFontSize } from "@/features/terminal/constants/terminalConfig";
import { resetReconnectState, recoveryBusy } from "@/features/terminal/lib/reconnectState";
import { createWriteBatcher } from "@/features/terminal/lib/termWriteBatcher";
import { createGapFetch } from "@/features/terminal/lib/gapFetch";
import { createHistoryChain } from "@/features/terminal/lib/historyChain";
import { createJoinSession } from "@/features/terminal/lib/termJoin";
import { createOutputRouter } from "@/features/terminal/lib/termOutputRouter";
import { writeChunked } from "@/features/terminal/lib/historyMirror";
import { useTermTouchGestures } from "@/features/terminal/hooks/useTermTouchGestures";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";

// Detect macOS WebKit (Safari / Tauri WKWebView) where xterm IME drop occurs
const isMacWebKit = () => {
  if (typeof navigator === "undefined") return false;
  const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent) || navigator.platform === "MacIntel";
  const isWebKit = /AppleWebKit/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg/i.test(navigator.userAgent);
  return isMac && isWebKit;
};

// Intercept IME input dropped by xterm on macOS WebKit (e.g. Vietnamese Simple Telex, OpenKey, EVKey)
function setupMacImeFix(term, container) {
  if (!isMacWebKit()) return () => {};
  const textarea = term?.textarea;
  const core = term?._core;
  const compHelper = core?._compositionHelper;
  if (!textarea || !core) return () => {};

  // Disable xterm's fragile timer-based diff which drops/duplicates characters in WebKit
  const origHandleChanges = compHelper?._handleAnyTextareaChanges;
  const origFinalize = compHelper?._finalizeComposition;
  const origInputEvent = core._inputEvent;

  let pending229 = false;
  let lastKeyDownKey = "";
  let lastCompositionText = "";
  const TELEX_TONE_KEYS = /^[sfrxj12345]$/i;

  if (compHelper) {
    compHelper._handleAnyTextareaChanges = () => {};
    // Override _finalizeComposition: commit exact composed string directly instead of substring diffing
    compHelper._finalizeComposition = function() {
      this._compositionView?.classList.remove("active");
      this._isComposing = false;
      this._isSendingComposition = false;
      if (lastCompositionText) {
        this._coreService.triggerDataEvent(lastCompositionText, true);
        lastCompositionText = "";
      }
      if (this._textarea) this._textarea.value = "";
    };
  }

  const onKeyDown = (event) => {
    if (event.target !== textarea) return;
    lastKeyDownKey = event.key || "";
    pending229 = (event.keyCode === 229 || event.which === 229 || event.key === "Process") && !event.isComposing;
  };

  const onKeyUp = (event) => {
    if (event.target === textarea && (event.keyCode === 229 || event.which === 229)) {
      setTimeout(() => { pending229 = false; }, 50);
    }
  };

  const onCompositionStart = () => {
    pending229 = false;
    lastCompositionText = "";
  };

  const onCompositionUpdate = (event) => {
    if (event.data) lastCompositionText = event.data;
  };

  const onCompositionEnd = (event) => {
    pending229 = false;
    if (event.data) lastCompositionText = event.data;
  };

  // Door 2: OpenKey / EVKey / 3rd-party IME (keyCode 229 or non-ASCII -> insertText)
  core._inputEvent = function(e) {
    const rawData = e.data || "";
    const cleanData = rawData.replace(/[​-‍ ﻿]/g, "");
    const isImeInput = pending229 || (cleanData && /[^\x00-\x7F]/.test(cleanData)) || e.inputType === "insertReplacementText";
    pending229 = false;

    if (isImeInput && cleanData && !compHelper?._isComposing && !this.optionsService.rawOptions.screenReaderMode) {
      this._keyPressHandled = false;
      this._unprocessedDeadKey = false;
      this._keyDownSeen = false;

      // OpenKey sends only 1 Backspace for non-tone letters after a toned vowel
      if (cleanData.length > 1 && !TELEX_TONE_KEYS.test(lastKeyDownKey)) {
        this.coreService.triggerDataEvent("\x7f", true);
      }

      this.coreService.triggerDataEvent(cleanData, true);
      this.cancel(e);
      if (this.textarea) this.textarea.value = "";
      return true;
    }

    return origInputEvent.call(this, e);
  };

  textarea.addEventListener("keydown", onKeyDown, { capture: true });
  textarea.addEventListener("keyup", onKeyUp, { capture: true });
  textarea.addEventListener("compositionstart", onCompositionStart, { capture: true });
  textarea.addEventListener("compositionupdate", onCompositionUpdate, { capture: true });
  textarea.addEventListener("compositionend", onCompositionEnd, { capture: true });
  if (container) {
    container.addEventListener("compositionupdate", onCompositionUpdate, { capture: true });
    container.addEventListener("compositionend", onCompositionEnd, { capture: true });
  }

  return () => {
    core._inputEvent = origInputEvent;
    if (compHelper) {
      if (origHandleChanges) compHelper._handleAnyTextareaChanges = origHandleChanges;
      if (origFinalize) compHelper._finalizeComposition = origFinalize;
    }
    textarea.removeEventListener("keydown", onKeyDown, { capture: true });
    textarea.removeEventListener("keyup", onKeyUp, { capture: true });
    textarea.removeEventListener("compositionstart", onCompositionStart, { capture: true });
    textarea.removeEventListener("compositionupdate", onCompositionUpdate, { capture: true });
    textarea.removeEventListener("compositionend", onCompositionEnd, { capture: true });
    if (container) {
      container.removeEventListener("compositionupdate", onCompositionUpdate, { capture: true });
      container.removeEventListener("compositionend", onCompositionEnd, { capture: true });
    }
  };
}

// Synthesize mouseup when buttons === 0 to fix lost pointerup on macOS WKWebView
function setupMacMouseFix(term, container) {
  if (!isMacWebKit() || !container) return () => {};

  let primaryMouseDown = false;

  const onMouseDown = (e) => {
    if (e.button === 0) {
      primaryMouseDown = true;
    }
  };

  const onMouseUp = (e) => {
    if (e.button === 0) {
      primaryMouseDown = false;
    }
  };

  const onMouseMove = (e) => {
    if (!primaryMouseDown || e.buttons !== 0) return;
    primaryMouseDown = false;
    e.stopImmediatePropagation();

    const syntheticMouseUp = new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
    });
    document.dispatchEvent(syntheticMouseUp);
  };

  const onCancelOrBlur = () => {
    if (primaryMouseDown) {
      primaryMouseDown = false;
      const syntheticMouseUp = new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0,
      });
      document.dispatchEvent(syntheticMouseUp);
    }
  };

  container.addEventListener("mousedown", onMouseDown);
  container.addEventListener("mouseup", onMouseUp);
  container.addEventListener("pointercancel", onCancelOrBlur);
  container.addEventListener("mouseleave", onCancelOrBlur);
  document.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("blur", onCancelOrBlur);

  return () => {
    container.removeEventListener("mousedown", onMouseDown);
    container.removeEventListener("mouseup", onMouseUp);
    container.removeEventListener("pointercancel", onCancelOrBlur);
    container.removeEventListener("mouseleave", onCancelOrBlur);
    document.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("blur", onCancelOrBlur);
  };
}

// isVisible: pane is shown; isFocused: receives keyboard input
export function useXTerm({ bus: propBus, sessionId, theme, terminalTheme, isVisible, isFocused, containerRef, mountDelay = 0, bgKey = "none", onInput, onSelectionMade }) {
  const storeBus = useConnectionStore((s) => s.bus);
  const bus = propBus || storeBus;
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const writeBatcherRef = useRef(null);
  const webglAddonRef = useRef(null);
  const loadWebGLRef = useRef(null);
  const disposeWebGLRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const resizeTimerRef = useRef(null);
  const doResizeRef = useRef(null);
  const doJoinSessionRef = useRef(null);
  const fireJoinRef = useRef(null);
  const forceNextRef = useRef(false);
  const joinNextRef = useRef(false);
  const stopMomentumRef = useRef(null);
  const cwdRef = useRef(null);
  const [cwd, setCwd] = useState(null);
  const webglEnabled = useTerminalStore((s) => s.webglEnabled);
  const fontSizeSetting = useTerminalStore((s) => s.fontSize);
  const onSelectionMadeRef = useRef(onSelectionMade);
  useEffect(() => { onSelectionMadeRef.current = onSelectionMade; }, [onSelectionMade]);
  const awaitingTuiOutputRef = useRef(false);
  const searchAddonRef = useRef(null);
  const [termReady, setTermReady] = useState(false);

  // Skip emit when fit yields unchanged cols/rows
  const lastPtySizeRef = useRef(null);

  // Scrollback history mirror for replay on prefix fetch
  const historyMirrorRef = useRef([]);
  const historyBytesRef = useRef(0);
  const historyTotalRef = useRef(0);
  const historyFetchingRef = useRef(false);
  const historyLastFetchRef = useRef(0);
  const historyHaveAtEmitRef = useRef(0);
  const prefixFragsRef = useRef(null);
  const lastSeqRef = useRef(null);
  const joiningRef = useRef(false);
  // Guards race window between recovery trigger and join emission
  const joinClaimedRef = useRef(false);
  const hardRejoinRef = useRef(null);
  const [joining, setJoining] = useState(false);
  const joinQueueRef = useRef([]);
  const joinGenRef = useRef(0);
  const scrollDisposeRef = useRef(null);
  const pendingRecoverRef = useRef(null);
  const requestRecoverRef = useRef(null);
  const isVisibleRef = useRef(isVisible);
  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
  const [historyFetching, setHistoryFetching] = useState(false);
  const maybeFetchHistoryRef = useRef(null);
  const userAtTopRef = useRef(false);
  const onPrefixSettledRef = useRef(null);
  const lastOutputAtRef = useRef(0);
  const outputTotalRef = useRef(0);

  // Transient tiny sizes re-wrap scrollback narrow irreversibly
  const emitResize = useCallback(() => {
    const term = termRef.current;
    if (!term || !bus) return;
    const { cols, rows } = term;
    if (cols < MIN_COLS || rows < MIN_ROWS) return;
    lastPtySizeRef.current = { cols, rows };
    bus.emit("resize", { sessionId, cols, rows });
  }, [bus, sessionId]);

  // Debounce resize after layout settles to avoid transient narrow wrap
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
      if (!term || term._isDisposed || !fitAddon || !bus) return;
      if (!el?.offsetWidth || !el?.offsetHeight) return;
      fitAddon.fit();
      const { cols, rows } = term;
      if (cols < MIN_COLS || rows < MIN_ROWS) return;
      const prev = lastPtySizeRef.current;
      const force = forceNextRef.current;
      const wantJoin = joinNextRef.current;
      forceNextRef.current = false;
      joinNextRef.current = false;
      if (!force && prev && prev.cols === cols && prev.rows === rows && !wantJoin) {
        joinClaimedRef.current = false;
        return;
      }
      lastPtySizeRef.current = { cols, rows };
      bus.emit("resize", { sessionId, cols, rows });
      if (wantJoin && !fireJoinRef.current) joinClaimedRef.current = false;
      if (wantJoin && fireJoinRef.current) {
        joinClaimedRef.current = true;
        term.reset();
        fireJoinRef.current(cols, rows);
      }
    }, SETTLE_DEBOUNCE_MS);
  }, [bus, sessionId, containerRef]);

  useEffect(() => { doResizeRef.current = doResize; }, [doResize]);

  // Initialize XTerm instance
  useEffect(() => {
    if (!containerRef.current || !bus || !sessionId) return;
    if (termRef.current) return;

    // Fresh session → no prior output; clear so a carrier switch right after join
    // can't reuse a stale warm timestamp from the previous session.
    lastOutputAtRef.current = 0;
    // Seq is per-session and starts over — a leftover value from the previous session
    // would classify this session's first chunk as a huge false gap.
    lastSeqRef.current = null;

    const term = new XTerm({
      ...TERMINAL_OPTIONS,
      fontSize: effectiveFontSize(fontSizeSetting),
      // Immutable after open(), so it must be on for every viewport the feature can
      // reach — the canvas goes transparent only while a background actually renders.
      allowTransparency: true,
      theme: applyTerminalBackground(resolveTerminalTheme(theme, terminalTheme) || THEMES.dark, theme === "dark" ? bgKey : "none")
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Unicode v11 width tables fix CJK/combining glyph misalignment on mobile
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.open(containerRef.current);
    const cleanupImeFix = setupMacImeFix(term, containerRef.current);
    const cleanupMouseFix = setupMacMouseFix(term, containerRef.current);

    // Coalesce high-frequency output bursts into one write per animation frame
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
        webglAddonRef.current = webglAddon;
        // Context loss (GPU reclaimed) → dispose, xterm auto falls back to DOM. Buffer text preserved.
        webglAddon.onContextLoss(() => {
          webglAddon?.dispose();
          webglAddon = null;
          webglAddonRef.current = null;
        });
        term.loadAddon(webglAddon);
        // Image addon only with WebGL active (VS Code parity, avoids GPU issues)
        if (ADDONS.image) term.loadAddon(new ImageAddon());
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
      webglAddon = null;
      fitAddon.fit();
      emitResize();
      term.refresh(0, term.rows - 1);
    };

    loadWebGLRef.current = loadWebGL;
    disposeWebGLRef.current = disposeWebGL;

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

    // Fetch older history prefix when scrolled near top
    const fetchHistory = (auto = false) => {
      const buf = term.buffer.active;
      if (HISTORY_FETCH.disabled) return false;
      if (historyFetchingRef.current) return false;
      if (buf.type === "alternate") return false;
      if (historyTotalRef.current <= 0) return false;
      if (historyTotalRef.current - historyBytesRef.current < HISTORY_FETCH.minFetchBytes) return false;
      const now = Date.now();
      if (!auto && now - historyLastFetchRef.current < HISTORY_FETCH.guardMs) return false;
      const atTop = buf.viewportY <= HISTORY_FETCH.topThresholdLines;
      if (!auto && !userAtTopRef.current) return false;
      if (!atTop) { if (!auto) userAtTopRef.current = false; return false; }
      if (!useConnectionStore.getState().connected) return false;

      historyFetchingRef.current = true;
      historyLastFetchRef.current = now;
      historyHaveAtEmitRef.current = historyBytesRef.current;
      setHistoryFetching(true);
      bus.emit("requestHistory", { sessionId, have: historyHaveAtEmitRef.current }, (result) => {
        if (!result || !result.success) { historyFetchingRef.current = false; setHistoryFetching(false); return; }
        if (!result.prefixLen) { historyFetchingRef.current = false; setHistoryFetching(false); }
        historyTotalRef.current = result.total || historyTotalRef.current;
      });
      return true;
    };
    const chain = createHistoryChain({
      fetchOlder: fetchHistory,
      isAtTop: () => (term.buffer.active.viewportY ?? 0) <= HISTORY_FETCH.topThresholdLines,
      max: HISTORY_FETCH.chainMax,
      delayMs: HISTORY_FETCH.chainDebounceMs
    });
    onPrefixSettledRef.current = () => chain.settled();

    const handleScroll = () => {
      if ((term.buffer.active.viewportY ?? 0) > HISTORY_FETCH.topThresholdLines) userAtTopRef.current = false;
    };
    const maybeFetchHistory = () => chain.gesture();
    scrollDisposeRef.current = term.onScroll(handleScroll);
    term.textarea?.addEventListener("keyup", maybeFetchHistory);
    maybeFetchHistoryRef.current = maybeFetchHistory;

    let peekTimer = null;
    let peekDeadline = null;
    let peekInFlight = false;
    let peekGen = 0;

    const gapFetch = createGapFetch({
      emit: (payload, ack) => bus.emit("requestGap", { sessionId, ...payload }, ack),
      writeChunk: (data) => {
        const b = writeBatcherRef.current;
        writeChunked(term, data, historyMirrorRef, historyBytesRef, b);
        b?.flush();
      },
      flush: () => writeBatcherRef.current?.flush(),
      onGapChunk: (seq) => { lastSeqRef.current = seq; },
      onFallback: () => hardRejoinRef.current?.("gap fallback"),
      log: (msg) => termLog("reconnect", msg),
      getFromSeq: () => (lastSeqRef.current ?? 0) + 1
    });

    // Blind recovery: wipe and replay daemon tail when seq recovery cannot serve
    const hardRejoin = (why) => {
      if (!termRef.current) return;
      if (!useConnectionStore.getState().connected) { pendingRecoverRef.current = why; return; }
      pendingRecoverRef.current = null;
      termLog("reconnect", `reset+rejoin (${why})`);
      joinClaimedRef.current = true;
      doJoinSessionRef.current?.(true);
    };
    hardRejoinRef.current = hardRejoin;

    // Queries agent for newest seq to detect and recover missed backgrounded output
    const runRecover = (reason) => {
      peekTimer = null;
      if (!isVisibleRef.current) { pendingRecoverRef.current = reason; return; }
      if (!useConnectionStore.getState().connected) { pendingRecoverRef.current = reason; return; }
      if (recoveryBusy({ joinClaimed: joinClaimedRef, joining: joiningRef, gapBusy: gapFetch.isBusy() })) return;
      if (lastSeqRef.current == null) return hardRejoin(`${reason}: no seq baseline`);
      const gen = ++peekGen;
      peekInFlight = true;
      peekDeadline = setTimeout(() => {
        peekDeadline = null;
        peekInFlight = false;
        peekGen++;
        termLog("reconnect", `${reason}: peekSeq timed out → retry`);
        pendingRecoverRef.current = pendingRecoverRef.current || reason;
        drainPending();
      }, PEEK_TIMEOUT_MS);
      bus.emit("peekSeq", { sessionId }, (res) => {
        if (gen !== peekGen) return;
        clearTimeout(peekDeadline);
        peekDeadline = null;
        peekInFlight = false;
        const agentSeq = res?.seq;
        if (agentSeq == null) return hardRejoin(`${reason}: agent has no seq`);
        const lastSeq = lastSeqRef.current ?? 0;
        // Counter rewound indicates agent restarted with a new output stream
        if (agentSeq < lastSeq) return hardRejoin(`${reason}: seq rewound ${lastSeq} → ${agentSeq}`);
        if (agentSeq === lastSeq) {
          termLog("reconnect", `${reason}: nothing missed (seq ${lastSeq})`);
          return drainPending();
        }
        if (recoveryBusy({ joinClaimed: joinClaimedRef, joining: joiningRef, gapBusy: gapFetch.isBusy() })) return drainPending();
        termLog("reconnect", `${reason}: peekSeq ${lastSeq} → ${agentSeq} → gapFetch`);
        gapFetch.start(agentSeq);
      });
    };

    // Debounces recovery triggers into a single peek round-trip
    const requestRecover = (reason) => {
      if (!isVisibleRef.current || peekInFlight) { pendingRecoverRef.current = reason; return; }
      if (peekTimer) clearTimeout(peekTimer);
      peekTimer = setTimeout(() => runRecover(reason), RECOVER_DEBOUNCE_MS);
    };
    requestRecoverRef.current = requestRecover;

    function drainPending() {
      const reason = pendingRecoverRef.current;
      if (!reason) return;
      pendingRecoverRef.current = null;
      requestRecover(reason);
    }

    const { handleOutput } = createOutputRouter({
      sessionId, term, writeBatcherRef, gapFetch,
      refs: {
        joiningRef, joinQueueRef, lastSeqRef, lastOutputAtRef, outputTotalRef,
        awaitingTuiOutputRef, userAtTopRef, historyFetchingRef, historyHaveAtEmitRef,
        historyMirrorRef, historyBytesRef, prefixFragsRef, onPrefixSettledRef
      },
      setHistoryFetching
    });
    bus.on("output", handleOutput);

    // OSC 7 cwd change pushed from daemon
    const handleCwdChange = (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      if (payload.cwd) { cwdRef.current = payload.cwd; setCwd(payload.cwd); useTerminalStore.getState().setCwd(sessionId, payload.cwd); }
    };
    bus.on("cwdChange", handleCwdChange);

    const doJoinSession = createJoinSession({
      bus, sessionId, term, fitAddon, writeBatcherRef, doResizeRef, fireJoinRef,
      refs: {
        historyMirrorRef, historyBytesRef, historyTotalRef, historyFetchingRef,
        userAtTopRef, joiningRef, joinClaimedRef, joinQueueRef, joinGenRef, lastSeqRef, cwdRef, setJoining
      },
      setCwd
    });
    // Stagger initial join by mountDelay to prevent simultaneous joins
    const joinTimer = mountDelay > 0 ? setTimeout(doJoinSession, mountDelay) : null;
    if (!joinTimer) doJoinSession();
    doJoinSessionRef.current = doJoinSession;

    const handleReconnect = () => {
      if (!termRef.current) return;
      resetReconnectState({
        historyFetching: historyFetchingRef,
        historyHaveAtEmit: historyHaveAtEmitRef,
        awaitingTuiOutput: awaitingTuiOutputRef,
        joining: joiningRef,
        joinClaimed: joinClaimedRef,
        joinQueue: joinQueueRef,
        prefixFrags: prefixFragsRef,
      });
      gapFetch.cancel();
      chain.cancel();
      clearTimeout(peekDeadline); peekDeadline = null;
      peekInFlight = false;
      peekGen++;
      setHistoryFetching(false);
      setJoining(false);
      requestRecover("reconnect");
    };
    bus.on("connect", handleReconnect);

    // Orientation change: wait for mobile layout to settle then force-refit
    const handleOrientationChange = () => setTimeout(() => {
      const term = termRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || term._isDisposed || !fitAddon) return;
      fitAddon.fit();
      fitAddon.fit();
      doResizeRef.current?.({ force: true });
    }, ORIENTATION_SETTLE_MS);
    window.addEventListener("orientationchange", handleOrientationChange);

    // Force redraw and recover backgrounded output when tab becomes visible
    const handleVisibilityChange = () => {
      if (!document.hidden && termRef.current) {
        termRef.current.refresh(0, termRef.current.rows - 1);
        if (useConnectionStore.getState().connected) {
          requestRecover("visible");
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("orientationchange", handleOrientationChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver.disconnect();
      wheelEl.removeEventListener("wheel", handleWheel);
      bus.off("connect", handleReconnect);
      bus.off("output", handleOutput);
      bus.off("cwdChange", handleCwdChange);
      if (scrollDisposeRef.current) scrollDisposeRef.current.dispose();
      onPrefixSettledRef.current = null;
      term.textarea?.removeEventListener("keyup", maybeFetchHistory);
      if (inputHandlerRef.current) inputHandlerRef.current.dispose();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      gapFetch.cancel();
      if (joinTimer) clearTimeout(joinTimer);
      if (peekTimer) clearTimeout(peekTimer);
      if (peekDeadline) clearTimeout(peekDeadline);
      if (webglAddonRef.current) webglAddonRef.current.dispose();
      if (writeBatcherRef.current) writeBatcherRef.current.dispose();
      cleanupImeFix();
      cleanupMouseFix();
      fitAddon.dispose();
      term.dispose();
      termRef.current = null;
      setTermReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, sessionId]);

  // Live WebGL toggle: swap renderer + re-fit on change (no reload needed)
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !bus || !sessionId) return;
    if (webglEnabled) loadWebGLRef.current?.();
    else disposeWebGLRef.current?.();
  }, [webglEnabled, bus, sessionId]);

  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !bus || !sessionId) return;
    if (fontSizeSetting == null) return;
    term.options.fontSize = fontSizeSetting;
    fitAddon.fit();
    emitResize();
    term.refresh(0, term.rows - 1);
  }, [fontSizeSetting, bus, sessionId, emitResize]);

  useEffect(() => {
    if (!termRef.current || !bus || !sessionId) return;

    if (inputHandlerRef.current) {
      inputHandlerRef.current.dispose();
      inputHandlerRef.current = null;
    }

    if (isFocused) {
      inputHandlerRef.current = termRef.current.onData((data) => {
        // Drop automated terminal reports (DA1/DA2/CPR) triggered by replaying historical output
        if ((joiningRef.current || historyFetchingRef.current) && isTerminalReport(data)) return;
        if (isUserTyping(data)) onInput?.(sessionId);
        bus.emit("input", { sessionId, data });
      });
    }
  }, [isFocused, bus, sessionId, onInput]);

  // Forward mouse-report sequences on hover when unfocused for alt-screen scrolling
  useEffect(() => {
    if (!termRef.current || !bus || !sessionId || isFocused) return;
    const isMouseReport = (d) => d.startsWith("\x1b[<") || d.startsWith("\x1b[M");
    const handler = termRef.current.onData((data) => {
      if (isMouseReport(data)) bus.emit("input", { sessionId, data });
    });
    return () => handler.dispose();
  }, [isFocused, bus, sessionId]);

  useEffect(() => {
    if (!isVisible || !fitAddonRef.current || !termRef.current) return;
    const timer = setTimeout(() => {
      if (pendingRecoverRef.current) {
        const reason = pendingRecoverRef.current;
        pendingRecoverRef.current = null;
        termLog("reconnect", `deferred recover → fire (pane now visible, ${reason})`);
        requestRecoverRef.current?.(reason);
      }
      doResize({ force: true });
      requestAnimationFrame(() => termRef.current?.refresh(0, termRef.current.rows - 1));
    }, 100);
    return () => clearTimeout(timer);
  }, [isVisible, doResize]);

  useEffect(() => {
    if (!isFocused) return;
    const mobile = typeof window !== "undefined" && window.innerWidth < 760;
    const timer = setTimeout(() => {
      doResize(mobile ? { force: true } : undefined);
      requestAnimationFrame(() => termRef.current?.refresh(0, termRef.current.rows - 1));
    }, 100);
    return () => clearTimeout(timer);
  }, [isFocused, doResize]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const effKey = theme === "dark" ? bgKey : "none";
    term.options.theme = applyTerminalBackground(resolveTerminalTheme(theme, terminalTheme) || THEMES.dark, effKey);
    term.refresh(0, term.rows - 1);
  }, [theme, terminalTheme, bgKey]);

  useTermTouchGestures({
    termRef, termReady, isVisible, bus, sessionId,
    onSelectionMadeRef, awaitingTuiOutputRef, maybeFetchHistoryRef, userAtTopRef,
    stopMomentumRef
  });

  // Reset XTerm and re-join session to re-fetch scrollback tail without bus reconnect
  const reload = useCallback(() => {
    const term = termRef.current;
    if (!term || !bus) return;
    termLog("join", "manual reload (user refetch)");
    doJoinSessionRef.current?.(true);
    if (webglEnabled) {
      disposeWebGLRef.current?.();
      loadWebGLRef.current?.();
    } else {
      term.refresh(0, term.rows - 1);
    }
  }, [bus, webglEnabled]);

  return {
    termRef,
    cwdRef,
    cwd,
    searchAddonRef,
    termReady,
    joining,
    doResize,
    reload,
    focus: () => termRef.current?.focus(),
    stopMomentum: () => stopMomentumRef.current?.(),
    historyFetching
  };
}
