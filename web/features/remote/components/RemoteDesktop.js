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
import { useI18n } from "@/shared/i18n";

const STORAGE_KEYS = {
  pointerMode: "remoteDesktop.pointerMode",
  showTextPanel: "remoteDesktop.showTextPanel",
  handMode: "remoteDesktop.handMode"
};

export default function RemoteDesktop({ onClose, socketRef, protocolRef, connected, transport }) {
  const { t } = useI18n();
  const [showHelp, setShowHelp] = useState(false);
  const [showConfirmExit, setShowConfirmExit] = useState(false);
  const [showTextPanel, setShowTextPanel] = usePersistedState(STORAGE_KEYS.showTextPanel, false);
  const [keyboardOn, setKeyboardOn] = useState(false);
  const [pointerMode, setPointerMode] = usePersistedState(STORAGE_KEYS.pointerMode, REMOTE_CONFIG.pointerMode);
  const [handMode, setHandMode] = usePersistedState(STORAGE_KEYS.handMode, false);

  const inputMode = useInputMode();
  // PC mode forces direct absolute pointing
  useEffect(() => {
    if (inputMode === "mouse" && pointerMode !== "direct") setPointerMode("direct");
  }, [inputMode, pointerMode, setPointerMode]);

  const { stats, trackTilesReceived, resetStats } = useBenchmark();
  const [showDebug, setShowDebug] = useState(REMOTE_CONFIG.debug?.panel ?? false);
  const [wsBlocked, setWsBlocked] = useState(false);
  const debugMode = REMOTE_CONFIG.enableWebRTC ? "rtc" : "ws";
  const copyStats = useCallback(() => {
    const snapshot = { mode: debugMode, ...stats, ts: new Date().toISOString() };
    navigator.clipboard?.writeText(JSON.stringify(snapshot, null, 2));
  }, [stats, debugMode]);

  // Periodic console log for benchmark comparison (copy console output to share)
  const statsRef = useRef(stats);
  useEffect(() => { statsRef.current = stats; }, [stats]);
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
    getCanvasCoordinates,
    resetZoom,
    centerVirtualCursor,
    startHandHold,
    releaseHandHold,
    handleCanvasInteraction,
    handleCanvasDimensions
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

  // Unified key emit — merges sticky UI modifiers with combo's own modifiers.
  const emitKeyDirect = useCallback((key, comboModifiers = []) => {
    if (!streaming) return;
    if (comboModifiers.length > 0) emitKeyPress(key, comboModifiers);
    else emitKeyWithActiveModifiers(key);
  }, [streaming, emitKeyPress, emitKeyWithActiveModifiers]);

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

    const onScreenDimensions = (dimensions) => {
      handleScreenDimensions(dimensions);
      handleCanvasDimensions(dimensions, renderedTilesRef);
      setTimeout(() => {
        socket.emit("request-screen-with-hashes", { tileHashes: [] });
      }, 100);
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

    socket.on("screen-dimensions", onScreenDimensions);
    socket.on("full-screen-data", onFullScreenData);
    socket.on("tiles-data", onTilesData);
    socket.on("tiles-data-binary", onTilesBinary);
    socket.on("tiles-bin-v2", onTilesBinV2);
    socket.on("tiles-meta", onTilesMeta);
    socket.on("screen-error", onScreenError);

    socket.emit("start-streaming");

    return () => {
      socket.emit("stop-streaming");
      socket.off("screen-dimensions", onScreenDimensions);
      socket.off("full-screen-data", onFullScreenData);
      socket.off("tiles-data", onTilesData);
      socket.off("tiles-data-binary", onTilesBinary);
      socket.off("tiles-bin-v2", onTilesBinV2);
      socket.off("tiles-meta", onTilesMeta);
      socket.off("screen-error", onScreenError);
      cleanupTiles();
      if (zoomGestureTimeoutRef.current) clearTimeout(zoomGestureTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    if (!streaming || !connected || !socketRef?.current) return;
    const id = setInterval(() => requestScreenWithHashes(), REMOTE_CONFIG.hashRequestInterval);
    return () => clearInterval(id);
  }, [streaming, connected, socketRef, requestScreenWithHashes]);

  // Pause stream when tab hidden to save CPU + bandwidth
  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket || !connected) return;
    const onVisibility = () => {
      if (document.hidden) {
        socket.emit("stop-streaming");
      } else {
        socket.emit("start-streaming");
        socket.emit("request-screen-with-hashes", { tileHashes: [] });
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
      handleSelection: (clientX, clientY, selType) => handleSelection(clientX, clientY, selType, {
        streaming,
        getCanvasCoordinates,
        baseCanvasSize,
        canvasZoom,
        canvasPan
      })
    });
  };

  return (
    <div
      className="bg-bg text-text flex flex-col landscape:flex-row h-[var(--app-height,100vh)] w-full"
      style={{
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent"
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
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
          virtualCursor={virtualCursor}
          inputMode={inputMode}
          keyboardOn={keyboardOn}
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
        />
      )}

      <RemoteControls
        streaming={streaming}
        canvasZoom={canvasZoom}
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
