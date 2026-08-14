import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { vibrate } from "@/shared/utils/vibration";
import { clamp, maxPanFor, clampPan, trackpadMultiplier, autoFollowPanAdjust } from "@/features/remote/lib/canvasGeometry";

// Virtual trackpad mode (Jump Desktop style) — touch-only. Selection anchors at the virtual
// cursor; long-press arms hand-hold (hand mode) or scroll lock (cursor freezes, drag scrolls).
// Returns true when the event was fully handled here (stop dispatch); false → fall through
// to touchMode (2-finger gestures and latched multi-touch).
export function handleTrackpadEvent(ctx, event, type, options) {
  const canvas = ctx.canvasRef.current;
  if (!canvas || canvas.width === 0) return true;

  const {
    selectionMode, dragMode, isDragging, setIsDragging, setDragMode,
    handleSelection, handMode = false, onHandRelease
  } = options;

  // Two-finger gestures fall through to the pinch-zoom/scroll block in touchMode
  if (event.touches?.length >= 2) {
    return false;
  } else if (!( !ctx.multiTouchLatchRef.current && (event.touches?.length === 1 || type === "touchend") )) {
    return false;
  }
  const touch = event.touches?.[0] || event.changedTouches?.[0];
  if (!touch) return true;

  if (type === "touch") {
    ctx.touchStartTimeRef.current = Date.now();
    ctx.touchTotalMoveRef.current = 0;
    ctx.setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
    ctx.lastTouchTimeRef.current = Date.now();
    // Selection mode: anchor selection start at the virtual cursor (not the finger)
    if (selectionMode) {
      const { percentX, percentY } = ctx.cursorPercent(ctx.virtualCursor, canvas);
      handleSelection?.(0, 0, "start", { ...options, percentOverride: { percentX, percentY } });
      return true;
    }
    // Hand mode: arm long-press to start hold-drag at the cursor (skip if already holding
    // via the toolbar toggle)
    if (handMode && !ctx.handHoldingRef.current) {
      if (ctx.handLongPressTimerRef.current) clearTimeout(ctx.handLongPressTimerRef.current);
      ctx.handLongPressTimerRef.current = setTimeout(() => {
        ctx.handLongPressTimerRef.current = null;
        const canvasNow = ctx.canvasRef.current;
        if (!canvasNow || canvasNow.width === 0) return;
        const { percentX, percentY } = ctx.cursorPercent(ctx.virtualCursor, canvasNow);
        ctx.handHoldingRef.current = true;
        ctx.setHandHolding(true);
        vibrate(15);
        ctx.socketEmitFunctions.emitMousePress?.(percentX, percentY, "left");
      }, REMOTE_CONFIG.longPressDelay);
    }
    // Non-hand mode: arm long-press to enter scroll lock (cursor freezes)
    if (!handMode && !ctx.scrollLockRef.current) {
      if (ctx.scrollLongPressTimerRef.current) clearTimeout(ctx.scrollLongPressTimerRef.current);
      ctx.scrollLongPressTimerRef.current = setTimeout(() => {
        ctx.scrollLongPressTimerRef.current = null;
        ctx.scrollLockRef.current = true;
        ctx.setScrollLock(true);
        ctx.edgeScrollAccumRef.current = { x: 0, y: 0 };
        vibrate(15);
      }, REMOTE_CONFIG.longPressDelay);
    }
    return true;
  }

  if (type === "touchmove") {
    const deltaX = touch.clientX - ctx.lastTouchCenter.x;
    const deltaY = touch.clientY - ctx.lastTouchCenter.y;
    ctx.touchTotalMoveRef.current += Math.abs(deltaX) + Math.abs(deltaY);

    // Scroll lock active: drag scrolls both axes, cursor stays frozen
    if (ctx.scrollLockRef.current) {
      ctx.emitScrollFromDelta(deltaY);
      ctx.emitHScrollFromDelta(deltaX);
      ctx.setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
      ctx.lastTouchTimeRef.current = Date.now();
      return true;
    }
    // Moved before lock fired → cancel pending long-press (treat as cursor move)
    if (ctx.scrollLongPressTimerRef.current &&
        ctx.touchTotalMoveRef.current > REMOTE_CONFIG.trackpadTapMaxMove) {
      clearTimeout(ctx.scrollLongPressTimerRef.current);
      ctx.scrollLongPressTimerRef.current = null;
    }

    const now = Date.now();
    const dt = Math.max(1, now - ctx.lastTouchTimeRef.current);
    const mult = trackpadMultiplier({ deltaX, deltaY, dt, cfg: REMOTE_CONFIG });

    // Screen-space delta → canvas-space (inverse of the CSS scale)
    const totalScale = Math.max(0.0001, ctx.fitScale * ctx.canvasZoom);
    const canvasDeltaX = (deltaX * mult) / totalScale;
    const canvasDeltaY = (deltaY * mult) / totalScale;

    // Selection mode: move the virtual cursor with the finger, expand the rect to it
    if (selectionMode) {
      ctx.setVirtualCursor(prev => {
        const next = {
          x: clamp(prev.x + canvasDeltaX, 0, canvas.width - 1),
          y: clamp(prev.y + canvasDeltaY, 0, canvas.height - 1)
        };
        const { percentX, percentY } = ctx.cursorPercent(next, canvas);
        ctx.emitVirtualCursor(next);
        handleSelection?.(0, 0, "move", { ...options, percentOverride: { percentX, percentY } });
        return next;
      });
      ctx.setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
      ctx.lastTouchTimeRef.current = now;
      return true;
    }

    // Hand mode: moving before the long-press fired cancels it (drag-without-hold)
    if (handMode && !ctx.handHoldingRef.current && ctx.handLongPressTimerRef.current &&
        ctx.touchTotalMoveRef.current > REMOTE_CONFIG.trackpadTapMaxMove) {
      clearTimeout(ctx.handLongPressTimerRef.current);
      ctx.handLongPressTimerRef.current = null;
    }

    ctx.setVirtualCursor(prev => {
      const next = {
        x: clamp(prev.x + canvasDeltaX, 0, canvas.width - 1),
        y: clamp(prev.y + canvasDeltaY, 0, canvas.height - 1)
      };
      ctx.emitVirtualCursor(next);
      if (ctx.handHoldingRef.current) {
        const { percentX, percentY } = ctx.cursorPercent(next, canvas);
        ctx.socketEmitFunctions.emitMouseMove?.(percentX, percentY);
      }

      // Auto-follow pan: keep the cursor inside the viewport margin (zoomed only,
      // where pan has room to move).
      const size = ctx.containerSize();
      if (size && ctx.canvasZoom > 1) {
        const displaySize = { width: canvas.width * totalScale, height: canvas.height * totalScale };
        const maxPan = maxPanFor(size, displaySize);
        ctx.setCanvasPan(p => {
          const adj = autoFollowPanAdjust({
            cursor: next, pan: p, containerSize: size, displaySize, totalScale,
            marginRatio: REMOTE_CONFIG.trackpadEdgeMarginRatio
          });
          return clampPan({ x: p.x + adj.x, y: p.y + adj.y }, maxPan);
        });
      }
      return next;
    });

    ctx.setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
    ctx.lastTouchTimeRef.current = now;
    return true;
  }

  if (type === "touchend") {
    // Selection mode: finalize drag-select at the virtual cursor
    if (selectionMode) {
      const { percentX, percentY } = ctx.cursorPercent(ctx.virtualCursor, canvas);
      handleSelection?.(0, 0, "end", { ...options, percentOverride: { percentX, percentY } });
      return true;
    }
    // Hand mode: cancel pending long-press, release if holding, then exit hand mode
    if (handMode) {
      if (ctx.handLongPressTimerRef.current) {
        clearTimeout(ctx.handLongPressTimerRef.current);
        ctx.handLongPressTimerRef.current = null;
      }
      if (ctx.handHoldingRef.current) {
        const { percentX, percentY } = ctx.cursorPercent(ctx.virtualCursor, canvas);
        ctx.socketEmitFunctions.emitMouseRelease?.(percentX, percentY, "left");
        ctx.handHoldingRef.current = false;
        ctx.setHandHolding(false);
        onHandRelease?.();
      }
      return true;
    }
    // Scroll lock: clear pending/active lock; skip click on release
    if (ctx.scrollLongPressTimerRef.current) {
      clearTimeout(ctx.scrollLongPressTimerRef.current);
      ctx.scrollLongPressTimerRef.current = null;
    }
    if (ctx.scrollLockRef.current) {
      ctx.scrollLockRef.current = false;
      ctx.setScrollLock(false);
      ctx.edgeScrollAccumRef.current = { x: 0, y: 0 };
      return true;
    }
    const duration = Date.now() - ctx.touchStartTimeRef.current;
    const isTap = ctx.touchTotalMoveRef.current <= REMOTE_CONFIG.trackpadTapMaxMove &&
                  duration <= REMOTE_CONFIG.trackpadTapMaxDuration;
    if (isTap) {
      const { percentX, percentY } = ctx.cursorPercent(ctx.virtualCursor, canvas);
      const doubleClick = ctx.checkDoubleClick(ctx.virtualCursor.x, ctx.virtualCursor.y);
      if (dragMode) {
        if (!isDragging) {
          setIsDragging(true);
          ctx.socketEmitFunctions.emitMousePress(percentX, percentY, "left");
        } else {
          setIsDragging(false);
          setDragMode(false);
          ctx.socketEmitFunctions.emitMouseRelease(percentX, percentY, "left");
        }
      } else {
        ctx.socketEmitFunctions.emitMouseClick(percentX, percentY, "left", doubleClick);
      }
    }
    return true;
  }

  return false;
}
