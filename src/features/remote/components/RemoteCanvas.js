"use client";

// Remote Desktop Canvas component - handles screen rendering
export default function RemoteCanvas({
  canvasRef,
  canvasContainerRef,
  canvasZoom,
  canvasPan,
  baseCanvasSize,
  streaming,
  selectionRect,
  clickIndicator,
  onMouseDown,
  onMouseMove,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onKeyDown
}) {
  return (
    <div
      className="w-full h-full overflow-hidden relative flex-1"
      ref={canvasContainerRef}
    >
      <canvas
        ref={canvasRef}
        className="block cursor-crosshair bg-black"
        style={{
          touchAction: "none",
          transformOrigin: "top left",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
          width: `${baseCanvasSize.width * canvasZoom}px`,
          height: `${baseCanvasSize.height * canvasZoom}px`,
          transform: `translate(${canvasPan.x}px, ${canvasPan.y}px)`,
          imageRendering: "pixelated"
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
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
