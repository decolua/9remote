"use client";

import { useEffect, useCallback, useState } from "react";
import { useRemoteSocket } from "@/features/remote/hooks/useRemoteSocket";
import { useCanvas } from "@/features/remote/hooks/useCanvas";
import { useInput } from "@/features/remote/hooks/useInput";
import { useTiles } from "@/features/remote/hooks/useTiles";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";
import RemoteCanvas from "@/features/remote/components/RemoteCanvas";
import RemoteControls from "@/features/remote/components/RemoteControls";
import Spinner from "@/shared/components/ui/Spinner";
import ConnectionModal from "@/shared/components/ui/ConnectionModal";
import { vibrate } from "@/shared/utils/vibration";

export default function RemoteDesktop({ onClose }) {
  const [isLandscape, setIsLandscape] = useState(false);

  // Detect orientation
  useEffect(() => {
    const checkOrientation = () => {
      setIsLandscape(window.innerWidth > window.innerHeight);
    };

    checkOrientation();
    window.addEventListener("resize", checkOrientation);
    return () => window.removeEventListener("resize", checkOrientation);
  }, []);

  const {
    socket,
    connected,
    streaming,
    error,
    authenticated,
    retryStatus,
    startStreaming,
    stopStreaming,
    emitRequestScreenWithHashes,
    emitMousePress,
    emitMouseRelease,
    emitMouseClick,
    emitMouseMove,
    emitMouseDragSelect,
    emitKeyPress,
    emitTypeText,
    emitScroll
  } = useRemoteSocket();

  const socketEmitFunctions = {
    emitRequestScreenWithHashes,
    emitMousePress,
    emitMouseRelease,
    emitMouseClick,
    emitMouseMove,
    emitMouseDragSelect,
    emitKeyPress,
    emitTypeText,
    emitScroll
  };

  // Handle close - return to terminal (socket cleanup handled by useEffect)
  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
    }
  }, [onClose]);

  const {
    canvasRef,
    canvasContainerRef,
    canvasZoom,
    canvasPan,
    baseCanvasSize,
    zoomGestureTimeoutRef,
    clickIndicator,
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
    startStreamingWithTiles,
    handleScreenDimensions,
    cleanupTiles,
    requestScreenWithHashes
  } = useTiles(socket, streaming, canvasRef);

  // Socket event listeners
  useEffect(() => {
    if (!authenticated || !socket) return;

    const onScreenDimensions = (dimensions) => {
      handleScreenDimensions(dimensions);
      handleCanvasDimensions(dimensions, renderedTilesRef);

      setTimeout(() => {
        if (!streaming && socket && connected) {
          startStreamingWithTiles(startStreaming);
        }
      }, 100);
    };

    const onFullScreenData = (data) => handleFullScreenData(data);
    const onTilesData = (data) => handleTilesData(data);
    const onScreenError = (error) => console.error("Screen error:", error);

    socket.on("screen-dimensions", onScreenDimensions);
    socket.on("full-screen-data", onFullScreenData);
    socket.on("tiles-data", onTilesData);
    socket.on("screen-error", onScreenError);

    return () => {
      socket.off("screen-dimensions", onScreenDimensions);
      socket.off("full-screen-data", onFullScreenData);
      socket.off("tiles-data", onTilesData);
      socket.off("screen-error", onScreenError);
      cleanupTiles();
      if (zoomGestureTimeoutRef.current) {
        clearTimeout(zoomGestureTimeoutRef.current);
      }
    };
  }, [authenticated, socket, streaming, connected, startStreaming, handleScreenDimensions, handleCanvasDimensions, renderedTilesRef, startStreamingWithTiles, handleFullScreenData, handleTilesData, cleanupTiles, zoomGestureTimeoutRef]);

  // Hash request interval
  useEffect(() => {
    if (!streaming || !socket || !connected) return;

    const hashRequestInterval = setInterval(() => {
      if (streaming && socket && connected) {
        requestScreenWithHashes();
      }
    }, REMOTE_CONFIG.hashRequestInterval);

    return () => clearInterval(hashRequestInterval);
  }, [streaming, socket, connected, requestScreenWithHashes]);

  // Create interaction handler
  const createInteractionHandler = (type) => (e) => {
    handleCanvasInteraction(e, type, {
      streaming,
      socket,
      selectionMode,
      selectionStart,
      dragMode,
      isDragging,
      setIsDragging,
      setDragMode,
      isMobile: type.includes("touch"),
      handleSelection: (clientX, clientY, selType) => handleSelection(clientX, clientY, selType, {
        streaming,
        getCanvasCoordinates,
        baseCanvasSize,
        canvasZoom,
        canvasPan
      })
    });
  };

  // Handle logout - back to login
  const handleLogout = useCallback(() => {
    sessionStorage.clear();
    window.location.href = "/login";
  }, []);

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
      {!authenticated ? (
        <div className="flex-1 flex items-center justify-center bg-dark-700">
          <Spinner size="lg" text="Connecting to remote..." />
        </div>
      ) : (
        <RemoteCanvas
          canvasRef={canvasRef}
          canvasContainerRef={canvasContainerRef}
          canvasZoom={canvasZoom}
          canvasPan={canvasPan}
          baseCanvasSize={baseCanvasSize}
          streaming={streaming}
          selectionRect={selectionRect}
          clickIndicator={clickIndicator}
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
        canvasZoom={canvasZoom}
        selectionMode={selectionMode}
        dragMode={dragMode}
        isDragging={isDragging}
        modifierKeys={modifierKeys}
        textInputValue={textInputValue}
        textInputRef={textInputRef}
        keyboardVisible={keyboardVisible}
        isLandscape={isLandscape}
        onStartStreaming={() => startStreamingWithTiles(startStreaming)}
        onStopStreaming={stopStreaming}
        onResetZoom={resetZoom}
        onRefresh={() => streaming && socket && emitRequestScreenWithHashes([])}
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
      />

      {/* Connection Modal - overlay when retrying/failed */}
      <ConnectionModal retryStatus={retryStatus} onLogout={handleLogout} />
    </div>
  );
}
