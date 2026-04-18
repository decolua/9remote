"use client";

import { useEffect, useCallback, useState } from "react";
import { useRemoteSocket } from "@/features/remote/hooks/useRemoteSocket";
import { useCanvas } from "@/features/remote/hooks/useCanvas";
import { useInput } from "@/features/remote/hooks/useInput";
import { useTiles } from "@/features/remote/hooks/useTiles";
import { useBenchmark } from "@/features/remote/hooks/useBenchmark";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import RemoteCanvas from "@/features/remote/components/RemoteCanvas";
import RemoteControls from "@/features/remote/components/RemoteControls";
import DebugPanel from "@/features/remote/components/DebugPanel";
import Spinner from "@/shared/components/ui/Spinner";

export default function RemoteDesktop({ onClose, socketRef, connected, connectionMode = "tunnel" }) {
  const [isLandscape, setIsLandscape] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [pointerMode, setPointerMode] = useState(REMOTE_CONFIG.pointerMode);
  const togglePointerMode = useCallback(() => {
    setPointerMode(prev => prev === "trackpad" ? "direct" : "trackpad");
  }, []);

  useEffect(() => {
    const checkOrientation = () => setIsLandscape(window.innerWidth > window.innerHeight);
    checkOrientation();
    window.addEventListener("resize", checkOrientation);
    return () => window.removeEventListener("resize", checkOrientation);
  }, []);

  const { stats, trackTilesReceived, resetStats } = useBenchmark();

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
    emitSetFocus
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

  const handleClose = useCallback(() => onClose?.(), [onClose]);

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
    getCanvasCoordinates,
    resetZoom,
    handleCanvasInteraction,
    handleCanvasDimensions
  } = useCanvas(socketEmitFunctions);

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
    toggleDragMode,
    handleTextInputFocus,
    handleCanvasKeyPress,
    startScrollUp,
    startScrollDown,
    startScrollLeft,
    startScrollRight,
    stopScrolling,
    sendTextInput,
    sendBackspace,
    sendArrowKey,
    sendEscKey,
    sendTabKey,
    sendEnterKey,
    handleSelection,
    handleModifiedTextInput
  } = useInput(socketEmitFunctions);

  const {
    renderedTilesRef,
    handleFullScreenData,
    handleTilesData,
    handleTilesBinary,
    handleTilesMeta,
    handleScreenDimensions,
    cleanupTiles,
    requestScreenWithHashes
  } = useTiles(socketRef, streaming, canvasRef);

  // Mount: register listeners + start streaming. Unmount: stop streaming + cleanup.
  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket || !connected) return;

    const onScreenDimensions = (dimensions) => {
      handleScreenDimensions(dimensions);
      handleCanvasDimensions(dimensions, renderedTilesRef);
      // Force full refresh after dimensions received
      setTimeout(() => {
        socket.emit("request-screen-with-hashes", { tileHashes: [] });
      }, 100);
    };
    const onFullScreenData = (data) => handleFullScreenData(data);
    const onTilesData = (data) => {
      if (showDebug) trackTilesReceived(data, data.transport || "ws");
      handleTilesData(data);
    };
    const onScreenError = (err) => console.error("Screen error:", err);

    const onTilesBinary = (buffer) => handleTilesBinary(buffer);
    const onTilesMeta = (meta) => handleTilesMeta(meta);

    socket.on("screen-dimensions", onScreenDimensions);
    socket.on("full-screen-data", onFullScreenData);
    socket.on("tiles-data", onTilesData);
    socket.on("tiles-data-binary", onTilesBinary);
    socket.on("tiles-meta", onTilesMeta);
    socket.on("screen-error", onScreenError);

    socket.emit("start-streaming");

    return () => {
      socket.emit("stop-streaming");
      socket.off("screen-dimensions", onScreenDimensions);
      socket.off("full-screen-data", onFullScreenData);
      socket.off("tiles-data", onTilesData);
      socket.off("tiles-data-binary", onTilesBinary);
      socket.off("tiles-meta", onTilesMeta);
      socket.off("screen-error", onScreenError);
      cleanupTiles();
      if (zoomGestureTimeoutRef.current) clearTimeout(zoomGestureTimeoutRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Hash request interval (backup sync)
  useEffect(() => {
    if (!streaming || !connected || !socketRef?.current) return;
    const id = setInterval(() => requestScreenWithHashes(), REMOTE_CONFIG.hashRequestInterval);
    return () => clearInterval(id);
  }, [streaming, connected, socketRef, requestScreenWithHashes]);

  // Focus-based streaming: emit visible canvas rect to server when pan/zoom changes.
  // zoom=1 → emit null (full screen). Debounced to avoid flooding during gesture.
  useEffect(() => {
    if (!streaming) return;
    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      const container = canvasContainerRef.current;
      if (!canvas || !container || canvas.width === 0) return;
      if (canvasZoom <= 1) { emitSetFocus(null); return; }

      const totalScale = fitScale * canvasZoom;
      if (totalScale <= 0) return;
      // Viewport rect in canvas-space: reverse pan then reverse scale
      const x = Math.max(0, -canvasPan.x / totalScale);
      const y = Math.max(0, -canvasPan.y / totalScale);
      const w = Math.min(canvas.width - x, container.clientWidth / totalScale);
      const h = Math.min(canvas.height - y, container.clientHeight / totalScale);
      emitSetFocus({ x: Math.floor(x), y: Math.floor(y), w: Math.ceil(w), h: Math.ceil(h) });
    }, REMOTE_CONFIG.focusDebounce);
    return () => clearTimeout(timer);
  }, [streaming, canvasZoom, canvasPan, fitScale, canvasRef, canvasContainerRef, emitSetFocus]);

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
      className={`bg-dark-700 text-white flex h-[var(--app-height,100vh)] w-full ${isLandscape ? "flex-row" : "flex-col"}`}
      style={{
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent",
        touchAction: "manipulation"
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {!connected ? (
        <div className="flex-1 flex items-center justify-center bg-dark-700">
          <Spinner size="lg" text="Connecting to remote..." />
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
          virtualCursor={virtualCursor}
          onMouseDown={createInteractionHandler("click")}
          onMouseMove={createInteractionHandler("move")}
          onTouchStart={createInteractionHandler("touch")}
          onTouchMove={createInteractionHandler("touchmove")}
          onTouchEnd={createInteractionHandler("touchend")}
          onKeyDown={(e) => handleCanvasKeyPress(e, streaming)}
        />
      )}

      <RemoteControls
        streaming={streaming}
        connected={connected}
        transport="ws"
        canvasZoom={canvasZoom}
        selectionMode={selectionMode}
        dragMode={dragMode}
        isDragging={isDragging}
        pointerMode={pointerMode}
        onTogglePointerMode={togglePointerMode}
        modifierKeys={modifierKeys}
        textInputValue={textInputValue}
        textInputRef={textInputRef}
        keyboardVisible={keyboardVisible}
        isLandscape={isLandscape}
        connectionMode={connectionMode}
        onResetZoom={resetZoom}
        onRefresh={() => streaming && emitRequestScreenWithHashes([])}
        onToggleSelection={toggleSelectionMode}
        onToggleDrag={toggleDragMode}
        onToggleModifier={toggleModifierKey}
        onScrollUp={startScrollUp}
        onScrollDown={startScrollDown}
        onScrollLeft={startScrollLeft}
        onScrollRight={startScrollRight}
        onStopScrolling={stopScrolling}
        onArrowKey={sendArrowKey}
        onEscKey={sendEscKey}
        onTabKey={sendTabKey}
        onEnterKey={sendEnterKey}
        onBackspace={sendBackspace}
        onTextInputChange={setTextInputValue}
        onTextInputFocus={handleTextInputFocus}
        onTextInputKeyDown={(e) => handleModifiedTextInput(e, streaming)}
        onSendText={sendTextInput}
        onClose={handleClose}
        onToggleDebug={() => setShowDebug(!showDebug)}
      />

      {showDebug && (
        <DebugPanel stats={stats} onReset={resetStats} onClose={() => setShowDebug(false)} />
      )}
    </div>
  );
}
