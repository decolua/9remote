"use client";

import { useEffect, useState } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

// Remote Desktop Canvas component - handles screen rendering
export default function RemoteCanvas({
  canvasRef,
  canvasContainerRef,
  canvasZoom,
  canvasPan,
  fitScale,
  streaming,
  selectionRect,
  clickIndicator,
  pointerMode,
  selectionMode,
  handMode,
  handHolding,
  virtualCursor,
  inputMode,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  onContextMenu,
  onDoubleClick,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onKeyDown
}) {
  // Canvas physical size = server resolution (set via canvas.width/height in handleCanvasDimensions).
  // CSS transform: scale(fitScale * canvasZoom) to fit into container then apply user zoom.
  // translate is applied before scale (via separate transform step) to pan in screen space.
  const totalScale = fitScale * canvasZoom;
  const isMouseInput = inputMode === "mouse";
  // Track physical-mouse drag state so the local cursor reflects "grabbing" while
  // a button is held down. CSS :active won't fire on <canvas> during drag.
  const [isDraggingMouse, setIsDraggingMouse] = useState(false);
  // Cursor hint:
  // - selection → crosshair
  // - hand mode → grab/grabbing
  // - PC mode + holding button → grabbing
  // - trackpad touch → grab
  // - otherwise → default (show local cursor so user can aim, matching RDP/VNC)
  const cursorClass = selectionMode
    ? "cursor-crosshair"
    : handMode
      ? (handHolding ? "cursor-grabbing" : "cursor-grab")
      : isMouseInput && isDraggingMouse
        ? "cursor-grabbing"
        : pointerMode === "trackpad"
          ? "cursor-grab active:cursor-grabbing"
          : "cursor-default";

  // Wheel event: attach via useEffect with { passive: false } so we can call
  // preventDefault() (React's onWheel is always passive and cannot preventDefault).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onWheel) return;
    const handler = (e) => onWheel(e);
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [canvasRef, onWheel]);

  // Auto-focus canvas on PC mode so physical keyboard keys are received immediately
  // without the user having to click the canvas first.
  useEffect(() => {
    if (!isMouseInput || !streaming) return;
    canvasRef.current?.focus();
  }, [canvasRef, isMouseInput, streaming]);

  // Re-focus canvas on every pointerdown so clicks never "steal" focus away.
  const handlePointerDown = (e) => {
    if (isMouseInput) {
      canvasRef.current?.focus();
      if (e.pointerType === "mouse") setIsDraggingMouse(true);
    }
    onPointerDown?.(e);
  };

  const handlePointerUp = (e) => {
    if (isMouseInput && e.pointerType === "mouse") setIsDraggingMouse(false);
    onPointerUp?.(e);
  };

  // Clear drag state if cursor leaves canvas or window (global pointerup listener
  // in useCanvas already handles the emit; we just sync the cursor style).
  useEffect(() => {
    if (!isDraggingMouse) return;
    const clear = () => setIsDraggingMouse(false);
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
    };
  }, [isDraggingMouse]);

  return (
    <div
      className="w-full h-full overflow-hidden relative flex-1"
      ref={canvasContainerRef}
      style={{ touchAction: "none" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <canvas
        ref={canvasRef}
        className={`block ${cursorClass} bg-black outline-none`}
        style={{
          touchAction: "none",
          transformOrigin: "top left",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
          transform: `translate3d(${canvasPan.x}px, ${canvasPan.y}px, 0) scale(${totalScale})`,
          imageRendering: "auto",
          willChange: "transform"
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        tabIndex={0}
        onKeyDown={onKeyDown}
      />

      {/* Selection Rectangle */}
      {selectionRect && (
        <div
          className="absolute border-2 border-blue-400 bg-blue-400/20 z-10"
          style={{
            left: `${selectionRect.x}px`,
            top: `${selectionRect.y}px`,
            width: `${selectionRect.width}px`,
            height: `${selectionRect.height}px`
          }}
        />
      )}

      {/* Virtual Cursor (trackpad mode) */}
      {pointerMode === "trackpad" && virtualCursor && (
        <div
          className="absolute pointer-events-none z-30"
          style={{
            left: `${virtualCursor.x * totalScale + canvasPan.x}px`,
            top: `${virtualCursor.y * totalScale + canvasPan.y}px`,
            width: `${REMOTE_CONFIG.trackpadCursorSize}px`,
            height: `${REMOTE_CONFIG.trackpadCursorSize}px`,
            transform: handMode ? "translate(-50%, -50%)" : "translate(-2px, -2px)"
          }}
        >
          {handMode ? (
            <div
              className="w-full h-full flex items-center justify-center drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
              style={{ fontSize: `${REMOTE_CONFIG.trackpadCursorSize}px`, lineHeight: 1 }}
            >
              {handHolding ? "✊" : "✋"}
            </div>
          ) : (
            <svg viewBox="0 0 24 24" className="w-full h-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
              <path
                d="M4 2 L4 18 L8.5 14 L11 20 L14 18.5 L11.5 13 L18 12.5 Z"
                fill="#ffffff"
                stroke="#000000"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      )}

      {/* Click Indicator */}
      {clickIndicator && (
        <div
          className="absolute pointer-events-none z-20"
          style={{
            left: `${clickIndicator.x - clickIndicator.size / 2}px`,
            top: `${clickIndicator.y - clickIndicator.size / 2}px`,
            width: `${clickIndicator.size}px`,
            height: `${clickIndicator.size}px`
          }}
        >
          <div className="w-full h-full rounded-full border-2 border-blue-400 bg-blue-400/30 animate-ping" />
          <div className="absolute inset-0 w-full h-full rounded-full border-2 border-blue-400 bg-blue-400/50" />
        </div>
      )}
    </div>
  );
}
