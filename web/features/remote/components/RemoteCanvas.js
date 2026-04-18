"use client";

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
  virtualCursor,
  onMouseDown,
  onMouseMove,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onKeyDown
}) {
  // Canvas physical size = server resolution (set via canvas.width/height in handleCanvasDimensions).
  // CSS transform: scale(fitScale * canvasZoom) to fit into container then apply user zoom.
  // translate is applied before scale (via separate transform step) to pan in screen space.
  const totalScale = fitScale * canvasZoom;
  // Cursor hint: crosshair for selection; grab in trackpad (draggable surface); default otherwise.
  const cursorClass = selectionMode
    ? "cursor-crosshair"
    : pointerMode === "trackpad"
      ? "cursor-grab active:cursor-grabbing"
      : "cursor-default";

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
        className={`block ${cursorClass} bg-black`}
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
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
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
            transform: "translate(-2px, -2px)"
          }}
        >
          <svg viewBox="0 0 24 24" className="w-full h-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            <path
              d="M4 2 L4 18 L8.5 14 L11 20 L14 18.5 L11.5 13 L18 12.5 Z"
              fill="#ffffff"
              stroke="#000000"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
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
