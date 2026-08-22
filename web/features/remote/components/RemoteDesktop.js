"use client";

import { useEffect, useCallback, useState, useRef } from "react";
import { useRemoteSocket } from "@/features/remote/hooks/useRemoteSocket";
import { useCanvas } from "@/features/remote/hooks/useCanvas";
import { useInput } from "@/features/remote/hooks/useInput";
import { useTiles } from "@/features/remote/hooks/useTiles";
import { useBenchmark } from "@/features/remote/hooks/useBenchmark";
import { useRemoteStream } from "@/features/remote/hooks/useRemoteStream";
import { useRemoteKeyboard } from "@/features/remote/hooks/useRemoteKeyboard";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import RemoteCanvas from "@/features/remote/components/RemoteCanvas";
import RemoteControls from "@/features/remote/components/RemoteControls";
import RemoteSidebar from "@/features/remote/components/RemoteSidebar";
import RemoteHelpModal from "@/features/remote/components/RemoteHelpModal";
import DebugPanel from "@/features/remote/components/DebugPanel";
import { debugLog } from "@/shared/utils/debugLog";
import Spinner from "@/shared/components/ui/Spinner";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import ClipboardModal from "@/features/remote/components/ClipboardModal";
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
  const [showClipboard, setShowClipboard] = useState(false);
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
  const debugMode = REMOTE_CONFIG.enableWebRTC ? "rtc" : "ws";
  const copyStats = useCallback(() => {
    const snapshot = { mode: debugMode, ...stats, ts: new Date().toISOString() };
    navigator.clipboard?.writeText(JSON.stringify(snapshot, null, 2)).catch(() => {});
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

  useEffect(() => {
    if (transport) debugLog("remote", `[remote] transport state: ${transport}`);
  }, [transport]);

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

  const { keyboardOnRef, toggleKeyboard, toggleTextPanel, handleTextInputBlur } = useRemoteKeyboard({
    streaming, keyboardOn, setKeyboardOn, showTextPanel, setShowTextPanel,
    textInputRef, canvasContainerRef, panForKeyboard, pointerMode, virtualCursor
  });

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

  const tiles = useTiles(socketRef, streaming, canvasRef);

  const {
    screenLocked,
    unlockReady,
    unlockResult,
    setUnlockResult,
    clipboardText,
    clipboardNew,
    setClipboardNew,
    monitors,
    activeMonitorIndex,
    cursorShape
  } = useRemoteStream({
    socketRef, connected, streaming,
    canvasRef, serverDimensionsRef, handleCanvasDimensions, resetPan,
    zoomGestureTimeoutRef, trackTilesReceived, tiles
  });

  // Clipboard badge auto-dismiss — reverts the toolbar button from clipboard
  // preview back to zoom-% after a timeout.
  useEffect(() => {
    if (!clipboardNew) return;
    const id = setTimeout(() => setClipboardNew(false), REMOTE_CONFIG.clipboardBadgeTimeout);
    return () => clearTimeout(id);
  }, [clipboardNew, clipboardText, setClipboardNew]);

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

  const handleToggleSelection = useCallback(() => {
    if (handMode) setHandMode(false);
    toggleSelectionMode();
  }, [handMode, setHandMode, toggleSelectionMode]);

  const createInteractionHandler = (type) => (e) => {
    handleCanvasInteraction(e, type, {
      streaming,
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
        {connected && (
          <RemoteSidebar
            streaming={streaming}
            canvasZoom={canvasZoom}
            pointerMode={pointerMode}
            handMode={handMode}
            keyboardOn={keyboardOn}
            selectionMode={selectionMode}
            show={show}
            onBack={handleClose}
            onRefresh={() => { if (streaming) emitRequestScreenWithHashes([]); }}
            onResetZoom={resetZoom}
            onTogglePointerMode={togglePointerMode}
            onToggleHandMode={toggleHandMode}
            onToggleKeyboard={toggleKeyboard}
            onShowHelp={() => setShowHelp(true)}
            onToggleSelection={handleToggleSelection}
          />
        )}
        {!connected ? (
          // Same poster stage the session list and terminal empty state open on, so the
          // wait reads as part of the app rather than a bare spinner.
          <div className="flex-1 min-w-0 empty-stage">
            <div className="empty-grid" />
            <div className="empty-half">
              <span className="empty-idx"><b>01</b> / {t("workspaces.emptyTagRemote")}</span>
              <span className="empty-word login-hero-grad">{t("workspaces.emptyWordRemote")}</span>
              <span className="empty-meta" dangerouslySetInnerHTML={{ __html: t("workspaces.emptyMetaRemote") }} />
              <span className="empty-go">
                <Spinner size="sm" />
                {t("remote.connecting")}
              </span>
            </div>
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
        onToggleSelection={handleToggleSelection}
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
        onTextInputBlur={handleTextInputBlur}
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
