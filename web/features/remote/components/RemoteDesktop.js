"use client";

import { useEffect, useCallback, useState, useRef } from "react";
import { useRemoteSocket } from "@/features/remote/hooks/useRemoteSocket";
import { useCanvas } from "@/features/remote/hooks/useCanvas";
import { useInput } from "@/features/remote/hooks/useInput";
import { useTiles } from "@/features/remote/hooks/useTiles";
import { useBenchmark } from "@/features/remote/hooks/useBenchmark";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import RemoteCanvas from "@/features/remote/components/RemoteCanvas";
import RemoteControls from "@/features/remote/components/RemoteControls";
import RemoteHelpModal from "@/features/remote/components/RemoteHelpModal";
import DebugPanel from "@/features/remote/components/DebugPanel";
import { debugLog } from "@/shared/utils/debugLog";
import Spinner from "@/shared/components/ui/Spinner";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import ClipboardModal from "@/features/remote/components/ClipboardModal";
import { ClipboardPaste, ChevronLeft, HelpCircle, Keyboard, RefreshCw, Hand } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

const STORAGE_KEYS = {
  pointerMode: "remoteDesktop.pointerMode",
  showTextPanel: "remoteDesktop.showTextPanel",
  handMode: "remoteDesktop.handMode",
  keyboard: "remoteDesktop.keyboard",
  controlsHidden: "remoteDesktop.controlsHidden"
};

export default function RemoteDesktop({ onClose, socketRef, protocolRef, connected, transport, hostPlatform }) {
  const { t } = useI18n();
  const [showHelp, setShowHelp] = useState(false);
  const [showConfirmExit, setShowConfirmExit] = useState(false);
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardNew, setClipboardNew] = useState(false);
  const [showClipboard, setShowClipboard] = useState(false);
  const [screenLocked, setScreenLocked] = useState(false);
  const [unlockReady, setUnlockReady] = useState(false);
  const [unlockResult, setUnlockResult] = useState(null); // {ok, reason} | null
  const [showTextPanel, setShowTextPanel] = usePersistedState(STORAGE_KEYS.showTextPanel, true);
  const [keyboardOn, setKeyboardOn] = usePersistedState(STORAGE_KEYS.keyboard, false);
  const [controlsHidden, setControlsHidden] = usePersistedState(STORAGE_KEYS.controlsHidden, false);
  const [pointerMode, setPointerMode] = usePersistedState(STORAGE_KEYS.pointerMode, REMOTE_CONFIG.pointerMode);
  const [handMode, setHandMode] = usePersistedState(STORAGE_KEYS.handMode, false);

  const inputMode = useInputMode();
  const pcCfg = REMOTE_CONFIG.pcModeControls;
  const show = (k) => inputMode !== "mouse" || pcCfg?.[k];
  // Tall landscape (iPad/tablet): full-width controls below canvas. Phone landscape keeps the
  // right sidebar. screen dimensions are physical — unaffected by soft keyboard shrinking viewport.
  const [isLandscape, setIsLandscape] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(orientation: landscape)");
    const update = () => setIsLandscape(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  const tallLandscape = isLandscape && Math.min(window.screen.width, window.screen.height) >= 700;
  // PC mode forces direct absolute pointing
  useEffect(() => {
    if (inputMode === "mouse" && pointerMode !== "direct") setPointerMode("direct");
  }, [inputMode, pointerMode, setPointerMode]);

  const { stats, trackTilesReceived, resetStats } = useBenchmark();
  const [showDebug, setShowDebug] = useState(REMOTE_CONFIG.debug?.panel ?? false);
  const [wsBlocked, setWsBlocked] = useState(false);
  const [monitors, setMonitors] = useState([]);
  const [activeMonitorIndex, setActiveMonitorIndex] = useState(0);
  const [cursorShape, setCursorShape] = useState(null);
  const debugMode = REMOTE_CONFIG.enableWebRTC ? "rtc" : "ws";
  const copyStats = useCallback(() => {
    const snapshot = { mode: debugMode, ...stats, ts: new Date().toISOString() };
    navigator.clipboard?.writeText(JSON.stringify(snapshot, null, 2)).catch(() => {});
  }, [stats, debugMode]);

  // Periodic console log for benchmark comparison (copy console output to share)
  const statsRef = useRef(stats);
  useEffect(() => { statsRef.current = stats; }, [stats]);

  // Clipboard badge auto-dismiss — reverts the toolbar button from clipboard
  // preview back to zoom-% after a timeout.
  useEffect(() => {
    if (!clipboardNew) return;
    const id = setTimeout(() => setClipboardNew(false), REMOTE_CONFIG.clipboardBadgeTimeout);
    return () => clearTimeout(id);
  }, [clipboardNew, clipboardText]);
  useEffect(() => {
    debugLog("remote", `[stats] interval started, mode=${debugMode}`);
    const id = setInterval(() => {
      debugLog("remote", `[stats][${debugMode}]`, JSON.stringify(statsRef.current));
    }, 5000);
    return () => {
      debugLog("remote", "[stats] interval stopped");
      clearInterval(id);
    };
  }, [debugMode]);

  const {
    streaming,
    emitRequestScreenWithHashes,
    emitMousePress,
    emitMouseRelease,
    emitMouseClick,
    emitMouseMove,
    emitMouseDragSelect,
    emitKeyPress,
    emitTypeText,
    emitScroll,
    emitBoostStream,
    emitSetFocus,
    emitDesktopSwitch
  } = useRemoteSocket(socketRef, connected);

  const socketEmitFunctions = {
    emitRequestScreenWithHashes,
    emitMousePress,
    emitMouseRelease,
    emitMouseClick,
    emitMouseMove,
    emitMouseDragSelect,
    emitKeyPress,
    emitTypeText,
    emitScroll,
    emitBoostStream
  };

  const handleClose = useCallback(() => {
    setShowConfirmExit(true);
  }, []);

  // Mirror keyboardOn into a ref so onBlur handler reads the latest value
  // synchronously (React state update from toggleKeyboard hasn't committed yet
  // when blur fires → without ref, the blur handler re-focuses and keyboard
  // can't be turned off on Android).
  const keyboardOnRef = useRef(keyboardOn);
  useEffect(() => { keyboardOnRef.current = keyboardOn; }, [keyboardOn]);

  const lastTileTransportRef = useRef(null);
  useEffect(() => {
    if (transport) debugLog("remote", `[remote] transport state: ${transport}`);
  }, [transport]);

  // Toggle native keyboard by focus/blur the hidden text input.
  // Must call focus() SYNCHRONOUSLY inside user gesture — iOS/Android block
  // focus-driven keyboard if wrapped in setTimeout/Promise.
  const toggleKeyboard = useCallback(() => {
    const next = !keyboardOn;
    keyboardOnRef.current = next; // sync before blur() so onBlur sees new value
    setKeyboardOn(next);
    if (next) textInputRef.current?.focus();
    else textInputRef.current?.blur();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardOn]);

  // Auto-focus hidden sink once when stream is ready and keyboard was left on (persisted).
  // Best-effort: desktop opens the native keyboard; mobile may block focus outside a gesture.
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (!streaming || autoFocusedRef.current || !keyboardOnRef.current) return;
    autoFocusedRef.current = true;
    textInputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  // When closing panel, sync-focus hidden sink to keep native keyboard visible (iOS gesture rule).
  // When opening, let RemoteControls' useEffect focus the panel textarea after slide-in.
  const toggleTextPanel = useCallback(() => {
    const next = !showTextPanel;
    if (!next && keyboardOn) textInputRef.current?.focus();
    setShowTextPanel(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTextPanel, keyboardOn]);


  const {
    canvasRef,
    canvasContainerRef,
    canvasZoom,
    canvasPan,
    fitScale,
    baseCanvasSize,
    zoomGestureTimeoutRef,
    clickIndicator,
    virtualCursor,
    handHolding,
    scrollLock,
    getCanvasCoordinates,
    resetZoom,
    resetPan,
    panForKeyboard,
    centerVirtualCursor,
    startHandHold,
    releaseHandHold,
    handleCanvasInteraction,
    handleCanvasDimensions,
    serverDimensionsRef
  } = useCanvas(socketEmitFunctions);

  const togglePointerMode = useCallback(() => {
    setPointerMode(prev => {
      const next = prev === "trackpad" ? "direct" : "trackpad";
      if (next === "trackpad") centerVirtualCursor();
      return next;
    });
  }, [centerVirtualCursor, setPointerMode]);


  const {
    textInputValue,
    setTextInputValue,
    textInputRef,
    keyboardVisible,
    modifierKeys,
    selectionMode,
    selectionStart,
    selectionRect,
    dragMode,
    isDragging,
    setIsDragging,
    setDragMode,
    toggleModifierKey,
    toggleSelectionMode,
    handleTextInputFocus,
    handleCanvasKeyPress,
    sendTextInput,
    handleSelection,
    handleModifiedTextInput,
    handleDirectInputChange,
    emitKeyWithActiveModifiers
  } = useInput(socketEmitFunctions);

  // On-screen keyboard shrinks the viewport from the bottom; at zoom>1 that can
  // hide the spot the user just tapped. A fixed timeout fired too early — the
  // container hadn't reflowed to the shrunk --app-height yet, so panForKeyboard
  // read the stale (tall) height and did nothing (pan only kicked in later on an
  // unrelated re-clamp, e.g. a mouse move). Instead poll clientHeight via rAF until
  // it actually changes, THEN pan — no timing guesswork.
  // Latest focus point (server px) to keep visible when the keyboard opens: the
  // virtual cursor in trackpad mode, else null (panForKeyboard falls back to the
  // last tapped point). Mirrored into a ref because the rAF callback below runs
  // async and would otherwise close over a stale cursor.
  const focusPxRef = useRef(null);
  useEffect(() => {
    focusPxRef.current = pointerMode === "trackpad" ? virtualCursor : null;
  }, [pointerMode, virtualCursor]);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let prevVVH = vv.height;
    let raf = 0;
    const onResize = () => {
      const shrank = vv.height < prevVVH;
      prevVVH = vv.height;
      const container = canvasContainerRef.current;
      if (!container) return;
      const startH = container.clientHeight;
      cancelAnimationFrame(raf);
      let tries = 0;
      const wait = () => {
        // clientHeight changed → reflow done, safe to read. Bail after ~30 frames.
        if (container.clientHeight !== startH || tries++ > 30) {
          panForKeyboard(shrank, focusPxRef.current);
          return;
        }
        raf = requestAnimationFrame(wait);
      };
      raf = requestAnimationFrame(wait);
    };
    vv.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(raf); vv.removeEventListener("resize", onResize); };
  }, [canvasContainerRef, panForKeyboard]);

  // Unified key emit — merges sticky UI modifiers with combo's own modifiers.
  // osAdaptive combos (undo/paste/cut/...) use ⌘ on a macOS host instead of Ctrl.
  const emitKeyDirect = useCallback((key, comboModifiers = [], osAdaptive = false) => {
    if (!streaming) return;
    if (comboModifiers.length > 0) {
      const mods = osAdaptive && hostPlatform === "darwin"
        ? comboModifiers.map((m) => (m === "control" ? "command" : m))
        : comboModifiers;
      emitKeyPress(key, mods);
    } else emitKeyWithActiveModifiers(key);
  }, [streaming, hostPlatform, emitKeyPress, emitKeyWithActiveModifiers]);

  // Hand mode: ON presses mouse-left at virtual cursor; OFF releases it.
  const toggleHandMode = useCallback(() => {
    setHandMode(prev => {
      const next = !prev;
      if (next) {
        if (selectionMode) toggleSelectionMode();
        startHandHold();
      } else {
        releaseHandHold();
      }
      return next;
    });
  }, [setHandMode, selectionMode, toggleSelectionMode, startHandHold, releaseHandHold]);

  const {
    renderedTilesRef,
    handleFullScreenData,
    handleTilesData,
    handleTilesBinary,
    handleTilesBinaryV2,
    handleTilesMeta,
    handleScreenDimensions,
    cleanupTiles,
    requestScreenWithHashes
  } = useTiles(socketRef, streaming, canvasRef);

  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket || !connected) return;

    // Reset stale tile state on (re)connect — stale hashes cause agent to skip tiles → black canvas
    cleanupTiles();

    const onScreenDimensions = (dimensions) => {
      handleScreenDimensions(dimensions);
      handleCanvasDimensions(dimensions, renderedTilesRef);
    };
    const onFullScreenData = (data) => handleFullScreenData(data);
    const onTilesData = (data) => {
      const via = data.transport || "ws";
      if (via !== lastTileTransportRef.current) {
        lastTileTransportRef.current = via;
        debugLog("remote", `[remote] tiles via ${via}`);
      }
      trackTilesReceived(data, via);
      handleTilesData(data);
    };
    const onScreenError = (err) => console.error("Screen error:", err);

    // Host desktop locked (Winlogon) → show unlock overlay. Emitted by the
    // Windows desktop bridge; ignored on other platforms.
    const onScreenLocked = ({ locked, ready } = {}) => {
      setScreenLocked(!!locked);
      setUnlockReady(!!ready);
      if (locked) setUnlockResult(null);
    };

    // Agent finished the unlock attempt — {ok, reason}.
    const onUnlockResult = (r) => setUnlockResult(r || null);

    const onTilesBinary = (buffer) => {
      const ab = buffer instanceof ArrayBuffer ? buffer : buffer?.buffer;
      const bytes = ab?.byteLength || 0;
      // Parse tileCount + timestamp from header (12B) for benchmark tracking
      let tileCount = 0;
      let timestamp = Date.now();
      if (ab && ab.byteLength >= 12) {
        const view = new DataView(ab);
        tileCount = view.getUint32(0, true);
        timestamp = view.getFloat64(4, false);
      }
      const via = "ws";
      if (via !== lastTileTransportRef.current) {
        lastTileTransportRef.current = via;
        debugLog("remote", `[remote] tiles via ${via}`);
      }
      trackTilesReceived({ tiles: new Array(tileCount), timestamp, bytes }, via);
      handleTilesBinary(buffer);
    };
    const onTilesMeta = (meta) => handleTilesMeta(meta);

    // v2 listener — atomic hash embedded per tile (new agent)
    const onTilesBinV2 = (buffer) => {
      const ab = buffer instanceof ArrayBuffer ? buffer : buffer?.buffer;
      const bytes = ab?.byteLength || 0;
      let tileCount = 0;
      let timestamp = Date.now();
      if (ab && ab.byteLength >= 12) {
        const view = new DataView(ab);
        tileCount = view.getUint32(0, true);
        timestamp = view.getFloat64(4, false);
      }
      const via = "ws";
      if (via !== lastTileTransportRef.current) {
        lastTileTransportRef.current = via;
        debugLog("remote", `[remote] tiles via ${via} v2`);
      }
      trackTilesReceived({ tiles: new Array(tileCount), timestamp, bytes }, via);
      handleTilesBinaryV2(buffer);
    };

    // Fresh handshake: wipe stale client tiles/hashes then request a full frame.
    // Reused on both mount and remote:ready (fired by agent after it (re)attaches
    // handlers for a NEW socket post-reconnect — the reliable "agent is ready" signal,
    // avoiding the race where start-streaming lands before addClient() on the agent).
    const doRestream = () => {
      cleanupTiles();
      socket.emit("get-screen-dimensions");
      // Ask the agent to re-emit the current lock state — the initial
      // screen-locked event fires before this listener mounts (race).
      socket.emit("get-unlock-state");
      // start-streaming alone clears agent checksums + pushes a full frame. Do NOT also
      // emit request-screen-with-hashes: it races the stream loop, fills the agent's
      // lastTileChecksums without delivering a full frame → agent thinks client is
      // synced → only diffs sent → black canvas.
      socket.emit("start-streaming");
    };

    // Agent (re)attached remote handlers on a new socket → reset everything fresh.
    const onRemoteReady = () => doRestream();

    // Host clipboard changed → stash text + badge. Agent seeds baseline on attach
    // (covers empty clipboard), so every event here is a real change worth showing.
    const onClipboardUpdate = ({ text, hash }) => {
      setClipboardText((prev) => {
        if (hash && hash === onClipboardUpdate._lastHash) return prev;
        onClipboardUpdate._lastHash = hash || null;
        return text || "";
      });
      setClipboardNew(true);
    };

    // Multi-monitor list from agent → drives the switcher UI.
    const onMonitors = ({ list, activeIndex }) => {
      setMonitors(Array.isArray(list) ? list : []);
      if (typeof activeIndex === "number") setActiveMonitorIndex(activeIndex);
    };
    // Agent switched the active display → drop stale tiles + reset pan so the
    // next frame paints the new monitor cleanly on a resized canvas. Zoom is
    // kept: it is a ratio, so it stays meaningful across monitor sizes.
    const onFrameMeta = (meta) => {
      cleanupTiles();
      resetPan();
      if (typeof meta?.monitorIndex === "number") setActiveMonitorIndex(meta.monitorIndex);
    };

    socket.on("screen-dimensions", onScreenDimensions);
    socket.on("full-screen-data", onFullScreenData);
    socket.on("tiles-data", onTilesData);
    socket.on("tiles-data-binary", onTilesBinary);
    socket.on("tiles-bin-v2", onTilesBinV2);
    socket.on("tiles-meta", onTilesMeta);
    socket.on("screen-error", onScreenError);
    socket.on("screen-locked", onScreenLocked);
    socket.on("unlock-result", onUnlockResult);
    socket.on("remote:ready", onRemoteReady);
    socket.on("clipboard-update", onClipboardUpdate);
    socket.on("monitors", onMonitors);
    socket.on("frame_meta", onFrameMeta);
    const onCursorShape = (data) => setCursorShape(data?.shape ?? null);
    socket.on("cursor-shape", onCursorShape);

    // Initial handshake on mount — agent may have emitted remote:ready before this
    // component mounted (socket already connected via terminal) so listener missed it.
    doRestream();

    return () => {
      socket.emit("stop-streaming");
      socket.off("screen-dimensions", onScreenDimensions);
      socket.off("full-screen-data", onFullScreenData);
      socket.off("tiles-data", onTilesData);
      socket.off("tiles-data-binary", onTilesBinary);
      socket.off("tiles-bin-v2", onTilesBinV2);
      socket.off("tiles-meta", onTilesMeta);
      socket.off("screen-error", onScreenError);
      socket.off("screen-locked", onScreenLocked);
      socket.off("unlock-result", onUnlockResult);
      socket.off("remote:ready", onRemoteReady);
      socket.off("clipboard-update", onClipboardUpdate);
      socket.off("monitors", onMonitors);
      socket.off("frame_meta", onFrameMeta);
      socket.off("cursor-shape", onCursorShape);
      cleanupTiles();
      if (zoomGestureTimeoutRef.current) clearTimeout(zoomGestureTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Periodic sync: once tiles are flowing, re-verify via hashes (steady state).
  // Before the first tile paints, requestScreenWithHashes() skips on empty hashes —
  // so pull a full frame directly (same as the refresh button) until the canvas is
  // no longer empty. Covers the case where start-streaming's initial full frame was
  // lost (transport not ready yet / landed before addClient / decode worker suspended).
  useEffect(() => {
    if (!streaming || !connected || !socketRef?.current) return;
    const id = setInterval(() => {
      if (renderedTilesRef.current.size === 0) {
        socketRef.current.emit("request-screen-with-hashes", { tileHashes: [] });
      } else {
        requestScreenWithHashes();
      }
    }, REMOTE_CONFIG.hashRequestInterval);
    return () => clearInterval(id);
  }, [streaming, connected, socketRef, requestScreenWithHashes, renderedTilesRef]);

  // WS reconnect (new server socket) is handled by the agent's remote:ready event
  // → onRemoteReady → doRestream. No socket.id polling needed.

  // Canvas has no dimensions → tiles draw into a 0×0 canvas → black screen while input
  // still works (mouse coords use %). Happens on re-entry: a fresh <canvas> mounts with
  // width=0 and the screen-dimensions event may have already fired. Independent of
  // `streaming` (dimensions must be applied regardless). Apply last known size, else ask
  // the agent. Runs immediately then retries until the canvas is sized.
  useEffect(() => {
    if (!connected) return;
    const ensureSized = () => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width > 0) return true;
      const { width, height } = serverDimensionsRef.current || {};
      if (width > 0) handleCanvasDimensions({ width, height }, renderedTilesRef);
      else socketRef.current?.emit("get-screen-dimensions");
      return false;
    };
    if (ensureSized()) return;
    const id = setInterval(() => { if (ensureSized()) clearInterval(id); }, REMOTE_CONFIG.restreamDelay);
    return () => clearInterval(id);
  }, [connected, socketRef, canvasRef, serverDimensionsRef, handleCanvasDimensions, renderedTilesRef]);

  // Pause stream when tab hidden to save CPU + bandwidth
  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket || !connected) return;
    const onVisibility = () => {
      if (document.hidden) {
        socket.emit("stop-streaming");
      } else {
        // start-streaming alone clears checksums + pushes a full frame. Emitting
        // request-screen-with-hashes([]) here races the stream loop → black canvas.
        socket.emit("start-streaming");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [connected, socketRef]);

  // Focus-based streaming: emit visible canvas rect on pan/zoom; zoom=1 → null (full screen)
  useEffect(() => {
    if (!streaming) return;
    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      const container = canvasContainerRef.current;
      if (!canvas || !container || canvas.width === 0) return;
      if (canvasZoom <= 1) { emitSetFocus(null, 1); return; }

      const totalScale = fitScale * canvasZoom;
      if (totalScale <= 0) return;
      const x = Math.max(0, -canvasPan.x / totalScale);
      const y = Math.max(0, -canvasPan.y / totalScale);
      const w = Math.min(canvas.width - x, container.clientWidth / totalScale);
      const h = Math.min(canvas.height - y, container.clientHeight / totalScale);
      emitSetFocus({ x: Math.floor(x), y: Math.floor(y), w: Math.ceil(w), h: Math.ceil(h) }, canvasZoom);
    }, REMOTE_CONFIG.focusDebounce);
    return () => clearTimeout(timer);
  }, [streaming, canvasZoom, canvasPan, fitScale, canvasRef, canvasContainerRef, emitSetFocus]);

  const onHandRelease = useCallback(() => setHandMode(false), [setHandMode]);

  const onSelectMonitor = useCallback((index) => {
    socketRef?.current?.emit("select_monitor", { index });
  }, [socketRef]);

  const createInteractionHandler = (type) => (e) => {
    handleCanvasInteraction(e, type, {
      streaming,
      socket: socketRef?.current,
      selectionMode,
      selectionStart,
      dragMode,
      isDragging,
      setIsDragging,
      setDragMode,
      isMobile: type.includes("touch"),
      pointerMode,
      handMode,
      onHandRelease,
      handleSelection: (clientX, clientY, selType, extra) => handleSelection(clientX, clientY, selType, {
        streaming,
        getCanvasCoordinates,
        baseCanvasSize,
        canvasZoom,
        canvasPan,
        ...extra
      })
    });
  };

  return (
    <div
      className={`bg-bg text-text flex flex-col h-[var(--app-height,100vh)] w-full ${tallLandscape ? "" : "landscape:flex-row"}`}
      style={{
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent"
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex flex-row flex-1 min-h-0">
      {/* Left toolbar — landscape only: back, refresh, zoom, pointer, keyboard, info, select */}
      {connected && (
        <div className="hidden landscape:flex flex-col items-center gap-1.5 py-2 px-1 bg-bg shrink-0 landscape:w-12 z-20">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { vibrate(); handleClose(); }}
            title={t("remote.back")}
            className="shrink-0 w-9 h-9 rounded-brand flex items-center justify-center bg-brand-500/15 hover:bg-brand-500/25 text-brand-400 transition-all duration-150 active:scale-[0.94]"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { vibrate(); if (streaming) emitRequestScreenWithHashes([]); }}
            disabled={!streaming}
            title={t("remote.refresh")}
            className="shrink-0 w-9 h-9 rounded-brand flex items-center justify-center bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text transition-all duration-150 active:scale-[0.94] disabled:opacity-50"
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { vibrate(); resetZoom(); }}
            disabled={!streaming}
            title={t("remote.resetZoom")}
            className="shrink-0 w-9 h-9 rounded-brand text-[10px] font-semibold flex items-center justify-center bg-surface-2 hover:bg-surface-3 text-text transition-all duration-150 active:scale-[0.94] disabled:opacity-50"
          >
            {Math.round(canvasZoom * 100)}%
          </button>
          {show("pointerModeToggle") && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { vibrate(); togglePointerMode(); }}
              disabled={!streaming}
              title={pointerMode === "trackpad" ? t("remoteControls.trackpadMode") : t("remoteControls.directMode")}
              className={`shrink-0 w-9 h-9 rounded-brand flex items-center justify-center text-base leading-none transition-all duration-150 active:scale-[0.94] disabled:opacity-50 ${pointerMode === "trackpad" ? "bg-brand-500 text-white" : "bg-surface-2 hover:bg-surface-3 text-text"}`}
            >
              🖱️
            </button>
          )}
          {show("handMode") && pointerMode === "trackpad" && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { vibrate(); toggleHandMode(); }}
              disabled={!streaming}
              title={t("remote.handMode")}
              className={`shrink-0 w-9 h-9 rounded-brand flex items-center justify-center transition-all duration-150 active:scale-[0.94] disabled:opacity-50 ${handMode ? "bg-brand-500 text-white" : "bg-surface-2 hover:bg-surface-3 text-text"}`}
            >
              <Hand size={16} />
            </button>
          )}
          {show("keyboardToggle") && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { vibrate(); toggleKeyboard(); }}
              disabled={!streaming}
              title={t("remote.toggleKeyboard")}
              className={`shrink-0 w-9 h-9 rounded-brand flex items-center justify-center transition-all duration-150 active:scale-[0.94] disabled:opacity-50 ${keyboardOn ? "bg-brand-500 text-white" : "bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text"}`}
            >
              <Keyboard size={16} />
            </button>
          )}
          {show("help") && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { vibrate(); setShowHelp(true); }}
              title={t("remote.help")}
              className="shrink-0 w-9 h-9 rounded-brand flex items-center justify-center bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text transition-all duration-150 active:scale-[0.94]"
            >
              <HelpCircle size={16} />
            </button>
          )}
          {show("rectangleSelect") && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { vibrate(); if (handMode) setHandMode(false); toggleSelectionMode(); }}
              disabled={!streaming}
              title={t("remote.rectangleSelection")}
              className={`shrink-0 w-9 h-9 rounded-brand flex items-center justify-center transition-all duration-150 active:scale-[0.94] disabled:opacity-50 ${selectionMode ? "bg-brand-500 text-white" : "bg-surface-2 hover:bg-surface-3 text-text"}`}
            >
              □
            </button>
          )}
        </div>
      )}
      {!connected ? (
        <div className="flex-1 flex items-center justify-center bg-bg">
          <Spinner size="lg" text={t("remote.connecting")} />
        </div>
      ) : (
        <RemoteCanvas
          canvasRef={canvasRef}
          canvasContainerRef={canvasContainerRef}
          canvasZoom={canvasZoom}
          canvasPan={canvasPan}
          fitScale={fitScale}
          streaming={streaming}
          selectionRect={selectionRect}
          clickIndicator={clickIndicator}
          pointerMode={pointerMode}
          selectionMode={selectionMode}
          handMode={handMode}
          handHolding={handHolding}
          scrollLock={scrollLock}
          virtualCursor={virtualCursor}
          cursorShape={cursorShape}
          inputMode={inputMode}
          keyboardOn={keyboardOn}
          monitors={monitors}
          activeMonitorIndex={activeMonitorIndex}
          onSelectMonitor={onSelectMonitor}
          onPointerDown={createInteractionHandler("pointerdown")}
          onPointerMove={createInteractionHandler("pointermove")}
          onPointerUp={createInteractionHandler("pointerup")}
          onWheel={createInteractionHandler("wheel")}
          onContextMenu={createInteractionHandler("contextmenu")}
          onDoubleClick={createInteractionHandler("dblclick")}
          onTouchStart={createInteractionHandler("touch")}
          onTouchMove={createInteractionHandler("touchmove")}
          onTouchEnd={createInteractionHandler("touchend")}
          onKeyDown={(e) => handleCanvasKeyPress(e, streaming)}
        screenLocked={screenLocked}
        unlockReady={unlockReady}
        unlockResult={unlockResult}
        onUnlockSubmit={(text) => {
          setUnlockResult(null);
          socketRef?.current?.emit("desktop-unlock", { text });
        }}
      />
      )}
      </div>

      <RemoteControls
        streaming={streaming}
        canvasZoom={canvasZoom}
        clipboardNew={clipboardNew}
        clipboardText={clipboardText}
        onOpenClipboard={() => { setClipboardNew(false); setShowClipboard(true); }}
        onDesktopSwitch={emitDesktopSwitch}
        selectionMode={selectionMode}
        pointerMode={pointerMode}
        handMode={handMode}
        inputMode={inputMode}
        onToggleHandMode={toggleHandMode}
        onTogglePointerMode={togglePointerMode}
        modifierKeys={modifierKeys}
        textInputValue={textInputValue}
        textInputRef={textInputRef}
        keyboardOn={keyboardOn}
        showTextPanel={showTextPanel}
        onResetZoom={resetZoom}
        onRefresh={() => streaming && emitRequestScreenWithHashes([])}
        onToggleSelection={() => {
          if (handMode) setHandMode(false);
          toggleSelectionMode();
        }}
        onToggleModifier={toggleModifierKey}
        onToggleKeyboard={toggleKeyboard}
        onToggleTextPanel={toggleTextPanel}
        controlsHidden={controlsHidden}
        onToggleControlsHidden={setControlsHidden}
        tallLandscape={tallLandscape}
        onToggleHelp={() => setShowHelp(true)}
        onEmitKey={emitKeyDirect}
        onTextInputChange={setTextInputValue}
        onTextInputFocus={handleTextInputFocus}
        onTextInputBlur={() => {
          // Re-focus to keep native keyboard visible. Use ref (not state) so toggleKeyboard's blur can close it.
          if (keyboardOnRef.current && !showTextPanel) setTimeout(() => textInputRef.current?.focus(), 0);
        }}
        onTextInputKeyDown={(e) => handleModifiedTextInput(e, streaming, keyboardOn)}
        onDirectInputChange={(value) => handleDirectInputChange(value, streaming)}
        onSendText={sendTextInput}
        onClose={handleClose}
        onToggleDebug={() => setShowDebug(s => !s)}
        debugOn={showDebug}
      />

      {showDebug && (
        <DebugPanel
          onForceWsDisconnect={() => socketRef?.current?.disconnect()}
          onToggleWsBlock={() => {
            const pm = protocolRef?.current;
            if (!pm) return;
            const next = !pm.wsBlocked;
            pm.setWsBlocked(next);
            setWsBlocked(next);
          }}
          isWsBlocked={wsBlocked}
          stats={stats}
          mode={debugMode}
          onReset={resetStats}
          onCopy={copyStats}
          onClose={() => setShowDebug(false)}
        />
      )}

      {showHelp && (
        <RemoteHelpModal
          inputMode={inputMode}
          pointerMode={pointerMode}
          onClose={() => {
            setShowHelp(false);
            if (keyboardOn) textInputRef.current?.focus();
          }}
        />
      )}

      {showClipboard && (
        <ClipboardModal
          text={clipboardText}
          onClose={() => setShowClipboard(false)}
        />
      )}

      <ConfirmDialog
        isOpen={showConfirmExit}
        onClose={() => {
          setShowConfirmExit(false);
          if (keyboardOn) textInputRef.current?.focus();
        }}
        onConfirm={() => onClose?.()}
        title={t("remote.exitRemote")}
        message={t("remoteControls.exitConfirmMessage")}
        confirmText={t("connection.exit")}
        cancelText={t("common.cancel")}
      />
    </div>
  );
}
