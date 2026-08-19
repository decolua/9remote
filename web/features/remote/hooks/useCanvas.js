"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { vibrate } from "@/shared/utils/vibration";
import { useCanvasViewport } from "@/features/remote/hooks/useCanvasViewport";
import {
  clamp, maxPanFor, clampPan, accumulateScrollDelta,
  isDoubleClick as isDoubleClickAt, momentumStep
} from "@/features/remote/lib/canvasGeometry";
import { handleMouseEvent } from "@/features/remote/lib/canvasInput/mouseMode";
import { handleTrackpadEvent } from "@/features/remote/lib/canvasInput/trackpadMode";
import { handleTouchEvent } from "@/features/remote/lib/canvasInput/touchMode";

export function useCanvas(socketEmitFunctions) {
  const viewport = useCanvasViewport();
  const {
    canvasRef, canvasContainerRef, canvasZoom, setCanvasZoom, canvasPan, setCanvasPan,
    fitScale, baseCanvasSize, containerSize, displaySizeAt, getCanvasCoordinates, recordInteractPx
  } = viewport;

  const [isZooming, setIsZooming] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [lastTouchDistance, setLastTouchDistance] = useState(0);
  const [lastTouchCenter, setLastTouchCenter] = useState({ x: 0, y: 0 });
  const [recentZoomGesture, setRecentZoomGesture] = useState(false);
  const zoomGestureTimeoutRef = useRef(null);
  const [clickIndicator, setClickIndicator] = useState(null);

  // Long-press and double-click detection
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const touchStartPosRef = useRef({ x: 0, y: 0 });
  const lastClickTimeRef = useRef(0);
  const lastClickPosRef = useRef({ x: 0, y: 0 });

  // Edge scroll with momentum
  const [isEdgeScrolling, setIsEdgeScrolling] = useState(false);
  const edgeScrollAccumRef = useRef({ x: 0, y: 0 });
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastTouchTimeRef = useRef(0);
  const momentumFrameRef = useRef(null);

  // Virtual cursor (trackpad mode) — position in server canvas pixels
  const [virtualCursor, setVirtualCursor] = useState({ x: 0, y: 0 });
  const touchStartTimeRef = useRef(0);
  const touchTotalMoveRef = useRef(0);

  // Two-finger gesture lock (zoom vs scroll) + multi-touch latch
  const gestureLockRef = useRef(null); // null | "zoom" | "scroll"
  const gestureStartRef = useRef({ time: 0, distance: 0, centerX: 0, centerY: 0 });
  const multiTouchLatchRef = useRef(false);
  const twoFingerMaxMovedRef = useRef(0);
  // True while the current 1-finger touch started in the letterbox (outside the canvas)
  const touchOutsideRef = useRef(false);

  // Hand-hold and trackpad scroll-lock timers/state
  const handLongPressTimerRef = useRef(null);
  const handHoldingRef = useRef(false);
  const [handHolding, setHandHolding] = useState(false);
  const scrollLongPressTimerRef = useRef(null);
  const scrollLockRef = useRef(false);
  const [scrollLock, setScrollLock] = useState(false);

  // PC mode: pressed mouse button + wheel burst state
  const mouseDownButtonRef = useRef(null);
  const wheelAccumRef = useRef({ x: 0, y: 0 });
  const wheelActiveRef = useRef(false);
  const wheelEndTimerRef = useRef(null);
  const wheelLastBoostRef = useRef(0);

  const showClickIndicator = useCallback((clientX, clientY) => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const x = clientX - containerRect.left;
    const y = clientY - containerRect.top;
    const size = clamp(7.5 * canvasZoom, 5, 15);

    recordInteractPx(x, y);
    setClickIndicator({ x, y, size });
    setTimeout(() => setClickIndicator(null), 500);
  }, [canvasZoom, canvasContainerRef, recordInteractPx]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const startLongPress = useCallback((clientX, clientY, percentX, percentY) => {
    cancelLongPress();
    longPressTriggeredRef.current = false;
    touchStartPosRef.current = { x: clientX, y: clientY };

    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      showClickIndicator(clientX, clientY);
      socketEmitFunctions?.emitMouseClick(percentX, percentY, "right");
    }, REMOTE_CONFIG.longPressDelay);
  }, [cancelLongPress, showClickIndicator, socketEmitFunctions]);

  const checkDoubleClick = useCallback((clientX, clientY) => {
    const now = Date.now();
    const result = isDoubleClickAt({
      now,
      lastTime: lastClickTimeRef.current,
      lastPos: lastClickPosRef.current,
      x: clientX, y: clientY,
      cfg: REMOTE_CONFIG
    });
    lastClickTimeRef.current = now;
    lastClickPosRef.current = { x: clientX, y: clientY };
    return result;
  }, []);

  const stopMomentum = useCallback(() => {
    if (momentumFrameRef.current) {
      cancelAnimationFrame(momentumFrameRef.current);
      momentumFrameRef.current = null;
    }
    velocityRef.current = { x: 0, y: 0 };
    edgeScrollAccumRef.current = { x: 0, y: 0 };
    setIsEdgeScrolling(false);
  }, []);

  // Momentum scroll after touch release (vertical only)
  const startMomentumScroll = useCallback(() => {
    const animate = () => {
      const step = momentumStep(velocityRef.current, REMOTE_CONFIG);
      if (!step) return stopMomentum();

      if (Math.abs(step.scrollY) >= 1) {
        socketEmitFunctions?.emitScroll(step.scrollY > 0 ? "up" : "down", Math.abs(step.scrollY), false);
      }
      velocityRef.current = step.nextVelocity;
      momentumFrameRef.current = requestAnimationFrame(animate);
    };
    momentumFrameRef.current = requestAnimationFrame(animate);
  }, [socketEmitFunctions, stopMomentum]);

  useEffect(() => {
    return () => {
      cancelLongPress();
      stopMomentum();
    };
  }, [cancelLongPress, stopMomentum]);

  // Accumulate scroll delta and emit once past threshold. Shared by 1-finger direct-mode
  // scroll, 2-finger trackpad scroll and the wheel path.
  const emitScrollFromDelta = useCallback((deltaY) => {
    const { edgeScrollThreshold, edgeScrollMultiplier } = REMOTE_CONFIG;
    const r = accumulateScrollDelta({
      accum: edgeScrollAccumRef.current.y, delta: deltaY,
      threshold: edgeScrollThreshold, multiplier: edgeScrollMultiplier
    });
    edgeScrollAccumRef.current.y = r.accum;
    if (r.scroll) socketEmitFunctions?.emitScroll(r.scroll > 0 ? "up" : "down", Math.abs(r.scroll), false);
  }, [socketEmitFunctions]);

  const emitHScrollFromDelta = useCallback((deltaX) => {
    const { edgeScrollThreshold, edgeScrollMultiplier } = REMOTE_CONFIG;
    const r = accumulateScrollDelta({
      accum: edgeScrollAccumRef.current.x, delta: deltaX,
      threshold: edgeScrollThreshold, multiplier: edgeScrollMultiplier
    });
    edgeScrollAccumRef.current.x = r.accum;
    if (r.scroll) socketEmitFunctions?.emitScroll(r.scroll > 0 ? "right" : "left", Math.abs(r.scroll), true);
  }, [socketEmitFunctions]);

  // Virtual cursor (canvas px) → server percentage
  const cursorPercent = useCallback((cursor, canvas) => ({
    percentX: clamp((cursor.x / canvas.width) * 100, 0, 100),
    percentY: clamp((cursor.y / canvas.height) * 100, 0, 100)
  }), []);

  const emitVirtualCursor = useCallback((cursor) => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;
    const { percentX, percentY } = cursorPercent(cursor, canvas);
    socketEmitFunctions?.emitMouseMove?.(percentX, percentY);
  }, [socketEmitFunctions, canvasRef, cursorPercent]);

  // Global pointerup — catches release outside the canvas so the remote mouse doesn't get
  // stuck pressed when the user drags out of bounds.
  useEffect(() => {
    const handleGlobalPointerUp = (e) => {
      if (mouseDownButtonRef.current == null) return;
      if (e.pointerType && e.pointerType !== "mouse") return;
      const canvas = canvasRef.current;
      const container = canvasContainerRef.current;
      if (!canvas || !container) return;
      const { percentX, percentY } = getCanvasCoordinates(e.clientX, e.clientY);
      const btn = mouseDownButtonRef.current;
      mouseDownButtonRef.current = null;
      socketEmitFunctions?.emitMouseRelease?.(percentX, percentY, btn);
    };
    window.addEventListener("pointerup", handleGlobalPointerUp);
    window.addEventListener("pointercancel", handleGlobalPointerUp);
    return () => {
      window.removeEventListener("pointerup", handleGlobalPointerUp);
      window.removeEventListener("pointercancel", handleGlobalPointerUp);
    };
  }, [getCanvasCoordinates, socketEmitFunctions, canvasRef, canvasContainerRef]);

  // Dispatch: mouse → mouseMode; trackpad touch → trackpadMode (may fall through);
  // everything else → touchMode. Branch order matches the pre-refactor flow exactly.
  const handleCanvasInteraction = useCallback((event, type, options) => {
    const { streaming, pointerMode = "direct" } = options;
    if (!streaming || !socketEmitFunctions) return;

    const ctx = {
      canvasRef, canvasContainerRef, containerSize, displaySizeAt,
      getCanvasCoordinates, socketEmitFunctions,
      canvasZoom, fitScale, virtualCursor, canvasPan,
      setCanvasZoom, setCanvasPan, setVirtualCursor,
      isZooming, isPanning, isEdgeScrolling, recentZoomGesture,
      lastTouchDistance, lastTouchCenter,
      setIsZooming, setIsPanning, setIsEdgeScrolling, setRecentZoomGesture,
      setLastTouchDistance, setLastTouchCenter,
      gestureLockRef, gestureStartRef, multiTouchLatchRef, twoFingerMaxMovedRef, touchOutsideRef,
      longPressTriggeredRef, touchStartPosRef,
      edgeScrollAccumRef, velocityRef, lastTouchTimeRef,
      touchStartTimeRef, touchTotalMoveRef,
      handLongPressTimerRef, handHoldingRef, setHandHolding,
      scrollLongPressTimerRef, scrollLockRef, setScrollLock,
      mouseDownButtonRef, wheelAccumRef, wheelActiveRef, wheelEndTimerRef, wheelLastBoostRef,
      zoomGestureTimeoutRef,
      showClickIndicator, cancelLongPress, startLongPress, checkDoubleClick,
      stopMomentum, startMomentumScroll,
      emitScrollFromDelta, emitHScrollFromDelta, cursorPercent, emitVirtualCursor
    };

    // ── PC mode branch: physical mouse / wheel / contextmenu / dblclick ─────
    const isMouseEvent = event.nativeEvent?.pointerType === "mouse"
      || event.type === "wheel"
      || event.type === "contextmenu"
      || event.type === "dblclick";
    if (isMouseEvent) {
      if (event.type === "wheel" || event.type === "contextmenu") event.preventDefault();
      return handleMouseEvent(ctx, event, type, options);
    }

    event.preventDefault();

    // Latch multi-touch — stays latched until all fingers up, so the virtual cursor doesn't
    // jump when one of two fingers lifts. A second finger cancels pending 1-finger long-presses
    // (scroll-lock + hand-hold), else the timer fires mid-zoom and hijacks the gesture.
    if (event.type.startsWith("touch") && event.touches?.length >= 2) {
      multiTouchLatchRef.current = true;
      if (scrollLongPressTimerRef.current) {
        clearTimeout(scrollLongPressTimerRef.current);
        scrollLongPressTimerRef.current = null;
      }
      if (scrollLockRef.current) {
        scrollLockRef.current = false;
        setScrollLock(false);
        edgeScrollAccumRef.current = { x: 0, y: 0 };
      }
      if (handLongPressTimerRef.current) {
        clearTimeout(handLongPressTimerRef.current);
        handLongPressTimerRef.current = null;
      }
    }

    // ── Virtual trackpad branch (Jump Desktop style) ─────────────────────
    if (pointerMode === "trackpad" && event.type.startsWith("touch")) {
      if (handleTrackpadEvent(ctx, event, type, options)) return;
    }

    handleTouchEvent(ctx, event, type, options);
  }, [
    isZooming, isPanning, isEdgeScrolling, canvasZoom, lastTouchDistance, lastTouchCenter,
    recentZoomGesture, fitScale, virtualCursor, canvasPan, getCanvasCoordinates, showClickIndicator,
    socketEmitFunctions, cancelLongPress, startLongPress, checkDoubleClick, stopMomentum,
    startMomentumScroll, emitVirtualCursor, emitScrollFromDelta, emitHScrollFromDelta,
    canvasRef, canvasContainerRef, containerSize, displaySizeAt,
    setCanvasPan, setCanvasZoom, cursorPercent
  ]);

  // Center the virtual cursor whenever canvas dimensions change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;
    setVirtualCursor(prev =>
      prev.x === 0 && prev.y === 0 ? { x: canvas.width / 2, y: canvas.height / 2 } : prev
    );
  }, [baseCanvasSize, canvasRef]);

  // Move the virtual cursor to the center of the VISIBLE viewport (not the full canvas) —
  // when zoomed, only part of the canvas is visible.
  const centerVirtualCursor = useCallback(() => {
    const canvas = canvasRef.current;
    const size = containerSize();
    if (!canvas || !size || canvas.width === 0) return;
    const totalScale = fitScale * canvasZoom;
    if (totalScale <= 0) return;
    setVirtualCursor({
      x: clamp((size.width / 2 - canvasPan.x) / totalScale, 0, canvas.width - 1),
      y: clamp((size.height / 2 - canvasPan.y) / totalScale, 0, canvas.height - 1)
    });
  }, [fitScale, canvasZoom, canvasPan, canvasRef, containerSize]);

  // Start hand-hold immediately at the current virtual cursor (no long-press)
  const startHandHold = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;
    if (handHoldingRef.current) return;
    if (handLongPressTimerRef.current) {
      clearTimeout(handLongPressTimerRef.current);
      handLongPressTimerRef.current = null;
    }
    const { percentX, percentY } = cursorPercent(virtualCursor, canvas);
    handHoldingRef.current = true;
    setHandHolding(true);
    vibrate(15);
    socketEmitFunctions?.emitBoostStream?.();
    socketEmitFunctions?.emitMousePress?.(percentX, percentY, "left");
  }, [virtualCursor, socketEmitFunctions, canvasRef, cursorPercent]);

  // Manual release (hand mode toggled OFF while still holding, without touchend)
  const releaseHandHold = useCallback(() => {
    if (!handHoldingRef.current) return;
    const canvas = canvasRef.current;
    const percentX = canvas && canvas.width > 0 ? (virtualCursor.x / canvas.width) * 100 : 0;
    const percentY = canvas && canvas.height > 0 ? (virtualCursor.y / canvas.height) * 100 : 0;
    socketEmitFunctions?.emitMouseRelease?.(percentX, percentY, "left");
    handHoldingRef.current = false;
    setHandHolding(false);
  }, [virtualCursor, socketEmitFunctions, canvasRef]);

  return {
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
    resetZoom: viewport.resetZoom,
    resetPan: viewport.resetPan,
    panForKeyboard: viewport.panForKeyboard,
    centerVirtualCursor,
    startHandHold,
    releaseHandHold,
    handleCanvasInteraction,
    handleCanvasDimensions: viewport.handleCanvasDimensions,
    serverDimensionsRef: viewport.serverDimensionsRef
  };
}
