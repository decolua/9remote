import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { vibrate } from "@/shared/utils/vibration";
import { clamp, maxPanFor, clampPan, zoomAtFocal, classifyGestureIntent, panWithEdgeOverflow, touchDistance, touchCenter, toCanvasPoint } from "@/features/remote/lib/canvasGeometry";

const MAX_ZOOM = 4;

// Raw (unclamped) canvas-px hit test — letterbox taps must not become edge clicks
function isOnCanvas(ctx, clientX, clientY) {
  const canvas = ctx.canvasRef.current;
  const container = ctx.canvasContainerRef.current;
  if (!canvas || !container || canvas.width === 0) return false;
  const p = toCanvasPoint({
    clientX, clientY,
    containerRect: container.getBoundingClientRect(),
    pan: ctx.canvasPan,
    totalScale: ctx.fitScale * ctx.canvasZoom
  });
  return p.x >= 0 && p.x <= canvas.width && p.y >= 0 && p.y <= canvas.height;
}

// Direct-mode touch: 2-finger pinch/scroll with gesture intent locking, 1-finger
// pan + edge-overflow scroll with momentum, touchend click/drag dispatch, and the
// mouse click/move fallback. Runs after mouseMode and trackpadMode declined the event.
export function handleTouchEvent(ctx, event, type, options) {
  const {
    selectionMode, selectionStart,
    dragMode, isDragging, setIsDragging, setDragMode,
    isMobile, handleSelection, pointerMode = "direct"
  } = options;

  // ── Multi-touch zoom/scroll — with gesture intent locking ──────────────
  if (event.type.startsWith("touch") && event.touches?.length >= 2 && !selectionMode) {
    const distance = touchDistance(event.touches);
    const center = touchCenter(event.touches);

    if (type === "touch") {
      ctx.setIsZooming(true);
      ctx.lastTouchDistanceRef.current = distance;
      ctx.lastTouchCenterRef.current = center;
      ctx.gestureLockRef.current = null;
      ctx.gestureStartRef.current = { time: Date.now(), distance, centerX: center.x, centerY: center.y };
      ctx.twoFingerMaxMovedRef.current = 0;
      return;
    } else if (type === "touchmove" && ctx.isZooming) {
      const container = ctx.canvasContainerRef.current;
      if (!container) return;

      if (ctx.gestureLockRef.current === null) {
        const elapsed = Date.now() - ctx.gestureStartRef.current.time;
        const deltaDistance = Math.abs(distance - ctx.gestureStartRef.current.distance);
        const deltaCentroid = Math.sqrt(
          (center.x - ctx.gestureStartRef.current.centerX) ** 2 +
          (center.y - ctx.gestureStartRef.current.centerY) ** 2
        );
        // Track max movement for the 2-finger tap check on touchend
        ctx.twoFingerMaxMovedRef.current = Math.max(ctx.twoFingerMaxMovedRef.current, deltaDistance, deltaCentroid);
        ctx.gestureLockRef.current = classifyGestureIntent({ elapsed, deltaDistance, deltaCentroid, cfg: REMOTE_CONFIG });
      }

      // Scroll mode: anchor the scroll position so the wheel event targets the right spot
      // (trackpad → virtual cursor, direct → 2-finger centroid), then scroll by centroid delta.
      if (ctx.gestureLockRef.current === "scroll") {
        const deltaY = center.y - ctx.lastTouchCenterRef.current.y;
        if (!ctx.isEdgeScrolling) {
          const canvasNow = ctx.canvasRef.current;
          const coords = (pointerMode === "trackpad" && canvasNow && canvasNow.width > 0)
            ? ctx.cursorPercent(ctx.virtualCursor, canvasNow)
            : ctx.getCanvasCoordinates(center.x, center.y);
          ctx.socketEmitFunctions?.emitBoostStream?.();
          ctx.socketEmitFunctions?.emitMouseMove?.(coords.percentX, coords.percentY);
          ctx.setIsEdgeScrolling(true);
        }
        ctx.emitScrollFromDelta(deltaY);
        ctx.lastTouchDistanceRef.current = distance;
        ctx.lastTouchCenterRef.current = center;
        return;
      }

      // Zoom mode: pinch-zoom canvas
      if (ctx.gestureLockRef.current === "zoom" && ctx.lastTouchDistanceRef.current > 0) {
        const containerRect = container.getBoundingClientRect();
        const size = { width: container.clientWidth, height: container.clientHeight };
        const focal = { x: center.x - containerRect.left, y: center.y - containerRect.top };
        const nextZoomRaw = ctx.canvasZoom * (distance / ctx.lastTouchDistanceRef.current);

        ctx.setCanvasPan(prev => zoomAtFocal({
          prevZoom: ctx.canvasZoom, prevPan: prev, focal, nextZoomRaw,
          maxZoom: MAX_ZOOM, containerSize: size, displaySizeAt: ctx.displaySizeAt
        }).pan);
        ctx.setCanvasZoom(clamp(nextZoomRaw, 1, MAX_ZOOM));
        ctx.lastTouchDistanceRef.current = distance;
      }

      ctx.lastTouchCenterRef.current = center;
      return;
    }
  }

  // ── Single touch ─────────────────────────────────────────────────────────
  if (event.type.startsWith("touch") && event.touches?.length === 1) {
    const touch = event.touches[0];

    // Skip while transitioning from 2 fingers to 1
    if (ctx.isZooming) {
      ctx.lastTouchCenterRef.current = { x: touch.clientX, y: touch.clientY };
      return;
    }

    if (type === "touch") {
      ctx.lastTouchCenterRef.current = { x: touch.clientX, y: touch.clientY };
      ctx.lastTouchTimeRef.current = Date.now();
      ctx.velocityRef.current = { x: 0, y: 0 };
      ctx.edgeScrollAccumRef.current = { x: 0, y: 0 };
      ctx.stopMomentum();

      ctx.touchOutsideRef.current = !isOnCanvas(ctx, touch.clientX, touch.clientY);

      if (selectionMode) {
        handleSelection(touch.clientX, touch.clientY, "start");
      } else if (!dragMode && !ctx.touchOutsideRef.current) {
        const { percentX, percentY } = ctx.getCanvasCoordinates(touch.clientX, touch.clientY);
        ctx.startLongPress(touch.clientX, touch.clientY, percentX, percentY);
      }
      return;
    } else if (type === "touchmove") {
      // Cancel long-press if moved too much
      const dx = Math.abs(touch.clientX - ctx.touchStartPosRef.current.x);
      const dy = Math.abs(touch.clientY - ctx.touchStartPosRef.current.y);
      if (dx > REMOTE_CONFIG.moveThreshold || dy > REMOTE_CONFIG.moveThreshold) ctx.cancelLongPress();

      if (selectionMode && selectionStart) {
        handleSelection(touch.clientX, touch.clientY, "move");
        return;
      }

      if (!selectionMode && !dragMode) {
        const deltaX = touch.clientX - ctx.lastTouchCenterRef.current.x;
        const deltaY = touch.clientY - ctx.lastTouchCenterRef.current.y;

        const now = Date.now();
        const dt = now - ctx.lastTouchTimeRef.current;
        if (dt > 0) {
          ctx.velocityRef.current = { x: deltaX / dt * 16, y: deltaY / dt * 16 }; // normalize to ~60fps
          ctx.lastTouchTimeRef.current = now;
        }

        if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
          ctx.cancelLongPress();
          const touchCoords = ctx.getCanvasCoordinates(touch.clientX, touch.clientY);
          // Only scroll vertically when the swipe is predominantly vertical
          const isVerticalSwipe = Math.abs(deltaY) > Math.abs(deltaX) * 1.5;

          // Init scroll state (emit mouseMove once) then accumulate delta
          const processScroll = (overflowY) => {
            if (!isVerticalSwipe) return;
            if (!ctx.isEdgeScrolling) {
              ctx.socketEmitFunctions?.emitBoostStream?.();
              ctx.socketEmitFunctions?.emitMouseMove?.(touchCoords.percentX, touchCoords.percentY);
              ctx.setIsEdgeScrolling(true);
            }
            ctx.emitScrollFromDelta(overflowY);
          };

          // zoom = 1: direct vertical scroll (like 2-finger on a macbook)
          if (ctx.canvasZoom === 1) {
            if (isVerticalSwipe) processScroll(deltaY);
            ctx.lastTouchCenterRef.current = { x: touch.clientX, y: touch.clientY };
            return;
          }

          // zoom > 1: pan first, edge scroll only when fully at the edge
          ctx.setIsPanning(true);
          const size = ctx.containerSize() || { width: 0, height: 0 };
          const displaySize = ctx.displaySizeAt(ctx.canvasZoom);
          ctx.setCanvasPan(prev => {
            const r = panWithEdgeOverflow({ prevPan: prev, deltaX, deltaY, containerSize: size, displaySize });
            if (Math.abs(r.overflowY) > 0) {
              processScroll(r.overflowY);
            } else {
              ctx.edgeScrollAccumRef.current.y = 0;
              ctx.setIsEdgeScrolling(false);
            }
            return r.pan;
          });
          ctx.lastTouchCenterRef.current = { x: touch.clientX, y: touch.clientY };
        }
        return;
      }
    }
  }

  // ── Touch end ────────────────────────────────────────────────────────────
  if (type === "touchend") {
    ctx.cancelLongPress();

    // 2-finger tap → right-click at the virtual cursor (trackpad only). Must run BEFORE
    // resetting gestureLockRef, and only when the gesture never committed to zoom/scroll.
    if (pointerMode === "trackpad" && ctx.isZooming &&
        (event.touches?.length || 0) === 0 &&
        ctx.gestureLockRef.current === null &&
        Date.now() - ctx.gestureStartRef.current.time <= REMOTE_CONFIG.trackpadTapMaxDuration &&
        ctx.twoFingerMaxMovedRef.current <= REMOTE_CONFIG.trackpadTapMaxMove) {
      const canvasNow = ctx.canvasRef.current;
      if (canvasNow && canvasNow.width > 0 && ctx.socketEmitFunctions?.emitMouseClick) {
        const { percentX, percentY } = ctx.cursorPercent(ctx.virtualCursor, canvasNow);
        ctx.socketEmitFunctions.emitMouseClick(percentX, percentY, "right");
        vibrate(15);
      }
    }

    ctx.gestureLockRef.current = null;
    // Release the multi-touch latch only when ALL fingers are lifted
    if ((event.touches?.length || 0) === 0) ctx.multiTouchLatchRef.current = false;

    const wasZooming = ctx.isZooming;
    const wasPanning = ctx.isPanning;
    const wasEdgeScrolling = ctx.isEdgeScrolling;
    const wasLongPress = ctx.longPressTriggeredRef.current;
    ctx.longPressTriggeredRef.current = false;

    if (wasZooming) {
      ctx.setRecentZoomGesture(true);
      if (ctx.zoomGestureTimeoutRef.current) clearTimeout(ctx.zoomGestureTimeoutRef.current);
      ctx.zoomGestureTimeoutRef.current = setTimeout(() => ctx.setRecentZoomGesture(false), 200);
    }

    if (wasEdgeScrolling && (Math.abs(ctx.velocityRef.current.x) > REMOTE_CONFIG.momentumMinVelocity ||
        Math.abs(ctx.velocityRef.current.y) > REMOTE_CONFIG.momentumMinVelocity)) {
      ctx.startMomentumScroll();
    } else {
      ctx.stopMomentum();
    }

    ctx.setIsZooming(false);
    ctx.setIsPanning(false);

    // Skip click if was zooming, panning, edge scrolling, or long-press already triggered
    if (wasZooming || wasPanning || wasEdgeScrolling || ctx.recentZoomGesture || wasLongPress) return;

    if (event.type.startsWith("touch")) {
      const touch = event.changedTouches?.[0];
      if (touch) {
        if (selectionMode) {
          handleSelection(touch.clientX, touch.clientY, "end");
        } else if (!ctx.touchOutsideRef.current) {
          const { percentX, percentY } = ctx.getCanvasCoordinates(touch.clientX, touch.clientY);
          ctx.showClickIndicator(touch.clientX, touch.clientY);

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
            const doubleClick = ctx.checkDoubleClick(touch.clientX, touch.clientY);
            ctx.socketEmitFunctions.emitMouseClick(percentX, percentY, "left", doubleClick);
          }
        }
      }
    }
    return;
  }

  if (ctx.isZooming || ctx.isPanning) return;

  // ── Mouse events (click/move fallback) ───────────────────────────────────
  let clientX, clientY;
  if (event.type.startsWith("touch")) {
    if (event.touches?.length !== 1) return;
    clientX = event.touches[0].clientX;
    clientY = event.touches[0].clientY;
  } else {
    clientX = event.clientX;
    clientY = event.clientY;
  }

  const { percentX, percentY } = ctx.getCanvasCoordinates(clientX, clientY);

  if (type === "click") {
    if (selectionMode) {
      handleSelection(clientX, clientY, selectionStart ? "end" : "start");
    } else {
      ctx.showClickIndicator(clientX, clientY);
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
        const doubleClick = ctx.checkDoubleClick(clientX, clientY);
        ctx.socketEmitFunctions.emitMouseClick(percentX, percentY, "left", doubleClick);
      }
    }
  } else if (type === "move" && !isMobile) {
    if (selectionMode && selectionStart) {
      handleSelection(clientX, clientY, "move");
      return;
    }
    ctx.socketEmitFunctions.emitMouseMove(percentX, percentY);
  }
}
