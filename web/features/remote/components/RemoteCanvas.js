"use client";

import { useEffect, useRef, useState } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { useI18n } from "@/shared/i18n";
import Icon, { Lock, Eye, EyeOff, Loader2 } from "@/shared/components/ui/Icon";
import MonitorSwitcher from "@/features/remote/components/MonitorSwitcher";

// Remote Desktop Canvas component - handles screen rendering
export default function RemoteCanvas({
  canvasRef,
  canvasContainerRef,
  canvasZoom,
  canvasPan,
  fitScale,
  streaming,
  hasFrame = true,
  selectionRect,
  clickIndicator,
  pointerMode,
  selectionMode,
  handMode,
  handHolding,
  scrollLock,
  virtualCursor,
  cursorShape,
  inputMode,
  keyboardOn,
  monitors,
  activeMonitorIndex,
  onSelectMonitor,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  onContextMenu,
  onDoubleClick,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onKeyDown,
  screenLocked,
  unlockReady,
  unlockResult,
  onUnlockSubmit
}) {
  // Canvas physical size = server resolution (set via canvas.width/height in handleCanvasDimensions).
  // CSS transform: scale(fitScale * canvasZoom) to fit into container then apply user zoom.
  // translate is applied before scale (via separate transform step) to pan in screen space.
  const totalScale = fitScale * canvasZoom;
  const isMouseInput = inputMode === "mouse";
  const { t } = useI18n();
  // Track physical-mouse drag state so the local cursor reflects "grabbing" while
  // a button is held down. CSS :active won't fire on <canvas> during drag.
  const [isDraggingMouse, setIsDraggingMouse] = useState(false);
  const [unlockText, setUnlockText] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [showPass, setShowPass] = useState(false);

  // Clear unlock field whenever the overlay hides — never keep the typed secret.
  useEffect(() => {
    if (!screenLocked) { setUnlockText(""); setUnlockBusy(false); }
  }, [screenLocked]);

  // Release the busy lock once a result arrives so the user can retry.
  useEffect(() => {
    if (unlockResult) setUnlockBusy(false);
  }, [unlockResult]);
  // Cursor hint:
  // - selection → crosshair
  // - hand mode → grab/grabbing
  // - PC mode + holding button → grabbing
  // - PC mode + OS resize handle → matching resize cursor
  // - trackpad touch → grab
  // - otherwise → default (show local cursor so user can aim, matching RDP/VNC)
  const RESIZE_CSS = {
    ew: "cursor-ew-resize", ns: "cursor-ns-resize",
    nwse: "cursor-nwse-resize", nesw: "cursor-nesw-resize", all: "cursor-move"
  };
  const cursorClass = selectionMode
    ? "cursor-crosshair"
    : handMode
      ? (handHolding ? "cursor-grabbing" : "cursor-grab")
      : isMouseInput && isDraggingMouse
        ? "cursor-grabbing"
        : (isMouseInput && cursorShape && RESIZE_CSS[cursorShape])
          ? RESIZE_CSS[cursorShape]
          : pointerMode === "trackpad"
            ? "cursor-grab active:cursor-grabbing"
            : "cursor-default";

  // Wheel event: attach via useEffect with { passive: false } so we can call
  // preventDefault() (React's onWheel is always passive and cannot preventDefault).
  // Read onWheel through a ref so the listener attaches ONCE — onWheel is a fresh
  // function every render (createInteractionHandler), and re-attaching per render
  // leaves gaps during zoom/scroll bursts where a wheel event slips through
  // un-prevented → browser shows the all-scroll (4-way arrow) cursor + native scroll.
  const onWheelRef = useRef(onWheel);
  useEffect(() => { onWheelRef.current = onWheel; }, [onWheel]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e) => onWheelRef.current?.(e);
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [canvasRef]);

  // Auto-focus canvas on PC mode so physical keyboard keys are received immediately
  // without the user having to click the canvas first.
  useEffect(() => {
    if (!isMouseInput || !streaming) return;
    canvasRef.current?.focus();
  }, [canvasRef, isMouseInput, streaming]);

  // Re-focus canvas on every pointerdown so clicks never "steal" focus away.
  const handlePointerDown = (e) => {
    const ae = document.activeElement;
    if (ae?.name === "remote-batch-input") {
      if (keyboardOn) {
        const sink = document.querySelector('textarea[name="remote-keyboard-sink"]');
        sink?.focus();
      } else {
        ae.blur();
      }
    }
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
    <div className="w-full h-full overflow-hidden relative flex-1">
      <div
        className="absolute inset-0"
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

      {/* First-frame wait: connected is not the same as seeing anything, and the canvas
          is plain black until the first tile paints. Below the lock screen (z-10) — a
          locked host is a real screen, not a stalled stream. */}
      {streaming && !hasFrame && !screenLocked && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 text-white/80 text-[11px] font-mono">
            <Loader2 size={12} className="animate-spin" />
            {t("remote.receivingImage", { defaultValue: "Receiving screen…" })}
          </div>
        </div>
      )}

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
            transform: (cursorShape || handMode || scrollLock || selectionMode) ? "translate(-50%, -50%)" : "translate(-2px, -2px)"
          }}
        >
          {scrollLock ? (
            <div
              className="w-full h-full flex items-center justify-center text-yellow-400 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
              style={{ fontSize: `${REMOTE_CONFIG.trackpadCursorSize}px`, lineHeight: 1 }}
            >
              ✥
            </div>
          ) : selectionMode ? (
            <svg viewBox="0 0 24 24" className="w-full h-full text-yellow-400 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
              <path
                d="M12 3 V21 M3 12 H21"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          ) : handMode ? (
            <div
              className="w-full h-full flex items-center justify-center drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
              style={{ fontSize: `${REMOTE_CONFIG.trackpadCursorSize}px`, lineHeight: 1 }}
            >
              {handHolding ? "✊" : "✋"}
            </div>
          ) : cursorShape ? (
            <svg
              viewBox="0 0 24 24"
              className="w-full h-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
              style={{ transform: `rotate(${cursorShape === "ns" ? 90 : cursorShape === "nwse" ? 45 : cursorShape === "nesw" ? -45 : 0}deg)` }}
            >
              {cursorShape === "all" ? (
                <path
                  d="M12 3 V21 M3 12 H21 M8 6 L12 2 L16 6 M8 18 L12 22 L16 18 M6 8 L2 12 L6 16 M18 8 L22 12 L18 16"
                  fill="#ffffff" stroke="#000000" strokeWidth="1.2"
                  strokeLinecap="round" strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M3 12 H21 M7 8 L3 12 L7 16 M17 8 L21 12 L17 16"
                  fill="#ffffff" stroke="#000000" strokeWidth="1.2"
                  strokeLinecap="round" strokeLinejoin="round"
                />
              )}
            </svg>
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
      {/* Monitor selector — sibling of the touch container so taps never bubble
          into the canvas pointer/touch handlers. Independent overlay. */}
      <MonitorSwitcher
        list={monitors}
        activeIndex={activeMonitorIndex}
        onSelect={onSelectMonitor}
      />

      {/* Lock-screen overlay — host is on the Winlogon desktop. Win11-style
          bloom background. Two modes:
            ready     → Windows PIN/password input (worker running)
            not ready → prompt to grant permission on the host UI first */}
      {screenLocked && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center"
          style={{ background: "radial-gradient(circle at 50% 40%, rgba(40,60,140,0.55) 0%, rgba(10,12,30,0.92) 60%, rgba(0,0,0,0.96) 100%)" }}
        >
          <div className="w-full max-w-[300px] mx-4 rounded-2xl p-5 shadow-2xl backdrop-blur-md" style={{ background: "rgba(20,22,40,0.85)", border: "1px solid rgba(120,140,220,0.25)" }}>
            {unlockReady ? (
              <>
                <div className="flex flex-col items-center gap-2 mb-4">
                  <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(120,140,220,0.18)" }}>
                    <Lock size={26} color="#a9b8ff" />
                  </div>
                  <h3 className="text-base font-semibold text-white">{t("remote.lockTitle")}</h3>
                  <p className="text-xs text-center" style={{ color: "rgba(220,225,245,0.7)" }}>
                    {t("remote.lockDesc")}
                  </p>
                </div>
                <div className="relative">
                  <input
                    type={showPass ? "text" : "password"}
                    value={unlockText}
                    autoFocus
                    disabled={unlockBusy}
                    onChange={(e) => setUnlockText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && unlockText && !unlockBusy) {
                        setUnlockBusy(true);
                        onUnlockSubmit?.(unlockText);
                      }
                    }}
                    placeholder={t("remote.lockPlaceholder")}
                    className="w-full rounded-xl px-4 py-2 pr-11 text-sm text-white focus:outline-none focus:border-blue-400"
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(120,140,220,0.35)" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    tabIndex={-1}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg"
                    style={{ color: "rgba(220,225,245,0.7)" }}
                    aria-label={showPass ? "Hide password" : "Show password"}
                  >
                    {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <button
                  type="button"
                  disabled={!unlockText || unlockBusy}
                  onClick={() => {
                    setUnlockBusy(true);
                    onUnlockSubmit?.(unlockText);
                  }}
                  className="w-full mt-2.5 rounded-xl py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg, #4a6cf7 0%, #6b8aff 100%)" }}
                >
                  {unlockBusy ? t("remote.unlocking") : t("remote.unlock")}
                </button>
                {unlockResult && !unlockResult.ok && (
                  <p className="mt-3 text-xs text-center text-red-300">
                    {t("remote.unlockFailed")}
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(120,140,220,0.18)" }}>
                  <Lock size={26} color="#a9b8ff" />
                </div>
                <h3 className="text-base font-semibold text-white">{t("remote.lockTitle")}</h3>
                <p className="text-xs" style={{ color: "rgba(220,225,245,0.85)" }}>
                  {t("remote.lockGrantDesc")}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
