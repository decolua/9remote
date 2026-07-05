"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { vibrate } from "@/shared/utils/vibration";

export function useCanvas(socketEmitFunctions) {
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [canvasPan, setCanvasPan] = useState({ x: 0, y: 0 });
  const [isZooming, setIsZooming] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [lastTouchDistance, setLastTouchDistance] = useState(0);
  const [lastTouchCenter, setLastTouchCenter] = useState({ x: 0, y: 0 });
  const [baseCanvasSize, setBaseCanvasSize] = useState({ width: 0, height: 0 });
  // fitScale: CSS scale to fit server canvas into container at zoom=1
  const [fitScale, setFitScale] = useState(1);
  const [recentZoomGesture, setRecentZoomGesture] = useState(false);
  const zoomGestureTimeoutRef = useRef(null);
  const [clickIndicator, setClickIndicator] = useState(null);
  
  // Long-press and double-click detection
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const touchStartPosRef = useRef({ x: 0, y: 0 });
  const lastClickTimeRef = useRef(0);
  const lastClickPosRef = useRef({ x: 0, y: 0 });
  // Last interaction point in SERVER canvas pixels — used to keep the spot the
  // user just touched visible when the on-screen keyboard opens (auto-pan).
  const lastInteractPxRef = useRef({ x: 0, y: 0 });
  
  // Store server dimensions for recalculation on resize
  const serverDimensionsRef = useRef({ width: 0, height: 0 });
  
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

  // Two-finger gesture lock: detect intent in first ~80ms then lock to zoom or scroll.
  // Prevents jitter between pinch-zoom and scroll.
  const gestureLockRef = useRef(null); // null | "zoom" | "scroll"
  const gestureStartRef = useRef({ time: 0, distance: 0, centerX: 0, centerY: 0 });
  // Latch: true once 2+ fingers touched, reset only when all fingers up.
  // Prevents trackpad cursor from moving when user lifts one finger during 2-finger gesture.
  const multiTouchLatchRef = useRef(false);

  // Hand mode long-press hold: tracks whether a hand-hold is armed/active.
  const handLongPressTimerRef = useRef(null);
  const handHoldingRef = useRef(false);
  const [handHolding, setHandHolding] = useState(false);

  // Trackpad long-press scroll lock: hold 1 finger still → enter scroll mode.
  // Cursor freezes, drag scrolls (both axes) instead of moving cursor.
  const scrollLongPressTimerRef = useRef(null);
  const scrollLockRef = useRef(false);
  const [scrollLock, setScrollLock] = useState(false);

  // 2-finger tap detection (trackpad mode → right-click). Tracks max centroid/distance
  // movement during the 2-finger gesture; if gesture never locked + within tap thresholds
  // on touchend, emit right-click at the virtual cursor.
  const twoFingerMaxMovedRef = useRef(0);

  // PC mode: track pressed mouse button to emit drag (move while held) and catch
  // pointerup even when the cursor leaves canvas.
  const mouseDownButtonRef = useRef(null);
  // Wheel delta accumulator (horizontal only; vertical reuses emitScrollFromDelta).
  const wheelAccumRef = useRef({ x: 0, y: 0 });
  // Wheel burst state: emit boostStream + mouseMove only ONCE per scroll burst
  // (mirrors touch `isEdgeScrolling` gating — avoids spamming mouseMove which is
  // throttled 8ms server-side and would otherwise starve scroll events).
  const wheelActiveRef = useRef(false);
  const wheelEndTimerRef = useRef(null);
  // Timestamp of last boostStream emit during wheel burst — throttled re-boost
  // keeps agent's idleFrameCount reset so stream stays full-speed for long bursts
  // (mirrors touch scroll which naturally re-boosts on each touchstart).
  const wheelLastBoostRef = useRef(0);

  // Get percentage-based coordinates
  // Canvas is rendered at server resolution, scaled by fitScale * canvasZoom via CSS transform.
  // We reverse the full CSS transform to map screen coords → canvas logical coords.
  const getCanvasCoordinates = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !container || canvas.width === 0) {
      return { percentX: 0, percentY: 0 };
    }

    const totalScale = fitScale * canvasZoom;
    const containerRect = container.getBoundingClientRect();
    const containerX = clientX - containerRect.left;
    const containerY = clientY - containerRect.top;
    // Reverse pan then reverse scale to get canvas logical pixel
    const canvasX = (containerX - canvasPan.x) / totalScale;
    const canvasY = (containerY - canvasPan.y) / totalScale;
    const percentX = (canvasX / canvas.width) * 100;
    const percentY = (canvasY / canvas.height) * 100;

    return {
      percentX: Math.max(0, Math.min(100, percentX)),
      percentY: Math.max(0, Math.min(100, percentY))
    };
  }, [canvasPan, canvasZoom, fitScale]);

  const getTouchDistance = useCallback((touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }, []);

  const getTouchCenter = useCallback((touches) => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  }), []);

  const showClickIndicator = useCallback((clientX, clientY) => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const x = clientX - containerRect.left;
    const y = clientY - containerRect.top;
    const size = Math.max(5, Math.min(15, 7.5 * canvasZoom));

    // Record interaction point in server pixels (zoom-independent) for keyboard auto-pan.
    const totalScale = fitScale * canvasZoom;
    if (totalScale > 0) {
      lastInteractPxRef.current = {
        x: (x - canvasPan.x) / totalScale,
        y: (y - canvasPan.y) / totalScale
      };
    }

    setClickIndicator({ x, y, size });
    setTimeout(() => setClickIndicator(null), 500);
  }, [canvasZoom, fitScale, canvasPan]);

  const resetZoom = useCallback(() => {
    setCanvasZoom(1);
    setCanvasPan({ x: 0, y: 0 });
  }, []);

  // Keyboard auto-pan: when the on-screen keyboard opens the container shrinks
  // from the bottom (--app-height follows visualViewport). At zoom>1 the point of
  // interest can fall behind the keyboard. Re-pan so that point sits ~1/3 down the
  // (now shorter) visible area. On close, re-clamp to a valid pan.
  // targetPx: point to keep visible, in server px. Trackpad mode passes the virtual
  // cursor; other modes fall back to the last tapped point. Without it we can't know
  // where the user is looking (this was the bug — it used the tap point in trackpad
  // mode where the cursor had since moved, so it appeared to do nothing).
  const panForKeyboard = useCallback((active, targetPx) => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const totalScale = fitScale * canvasZoom;
    if (totalScale <= 0) return;

    const focus = targetPx || lastInteractPxRef.current;
    const displayW = baseCanvasSize.width * canvasZoom;
    const displayH = baseCanvasSize.height * canvasZoom;
    const maxPanX = Math.min(0, container.clientWidth - displayW);
    const maxPanY = Math.min(0, container.clientHeight - displayH);

    setCanvasPan(prev => {
      if (!active || canvasZoom <= 1) {
        // Just re-clamp — container grew back, keep pan valid.
        return {
          x: Math.max(maxPanX, Math.min(0, prev.x)),
          y: Math.max(maxPanY, Math.min(0, prev.y))
        };
      }
      // Place focus point at ~1/3 down the visible area.
      const targetY = container.clientHeight / 3;
      const newPanY = targetY - focus.y * totalScale;
      return {
        x: Math.max(maxPanX, Math.min(0, prev.x)),
        y: Math.max(maxPanY, Math.min(0, newPanY))
      };
    });
  }, [canvasContainerRef, fitScale, canvasZoom, baseCanvasSize]);

  // Cancel long-press timer
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Start long-press detection
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

  // Check if double-click
  const checkDoubleClick = useCallback((clientX, clientY) => {
    const now = Date.now();
    const timeDiff = now - lastClickTimeRef.current;
    const dx = Math.abs(clientX - lastClickPosRef.current.x);
    const dy = Math.abs(clientY - lastClickPosRef.current.y);
    
    const isDoubleClick = timeDiff < REMOTE_CONFIG.doubleClickDelay && 
                          dx < REMOTE_CONFIG.moveThreshold && 
                          dy < REMOTE_CONFIG.moveThreshold;
    
    lastClickTimeRef.current = now;
    lastClickPosRef.current = { x: clientX, y: clientY };
    
    return isDoubleClick;
  }, []);

  // Stop momentum scroll
  const stopMomentum = useCallback(() => {
    if (momentumFrameRef.current) {
      cancelAnimationFrame(momentumFrameRef.current);
      momentumFrameRef.current = null;
    }
    velocityRef.current = { x: 0, y: 0 };
    edgeScrollAccumRef.current = { x: 0, y: 0 };
    setIsEdgeScrolling(false);
  }, []);

  // Start momentum scroll after touch release (vertical only)
  const startMomentumScroll = useCallback(() => {
    const { momentumFriction, momentumMinVelocity, edgeScrollMultiplier } = REMOTE_CONFIG;
    
    const animate = () => {
      const vy = velocityRef.current.y;
      
      if (Math.abs(vy) < momentumMinVelocity) {
        stopMomentum();
        return;
      }
      
      // Emit vertical scroll based on velocity
      const scrollY = Math.round(vy * edgeScrollMultiplier);
      
      if (Math.abs(scrollY) >= 1) {
        socketEmitFunctions?.emitScroll(scrollY > 0 ? "up" : "down", Math.abs(scrollY), false);
      }
      
      // Apply friction
      velocityRef.current.x *= momentumFriction;
      velocityRef.current.y *= momentumFriction;
      
      momentumFrameRef.current = requestAnimationFrame(animate);
    };
    
    momentumFrameRef.current = requestAnimationFrame(animate);
  }, [socketEmitFunctions, stopMomentum]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelLongPress();
      stopMomentum();
    };
  }, [cancelLongPress, stopMomentum]);

  // Recalculate fitScale: CSS scale that fits server canvas into container at zoom=1
  const recalculateDisplaySize = useCallback(() => {
    const container = canvasContainerRef.current;
    const canvas = canvasRef.current;
    const serverWidth = serverDimensionsRef.current.width;
    const serverHeight = serverDimensionsRef.current.height;

    if (!container || !canvas || serverWidth === 0 || serverHeight === 0) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    // Scale to fit entire canvas within container, preserving aspect ratio
    const scale = Math.min(containerWidth / serverWidth, containerHeight / serverHeight);
    setFitScale(scale);

    // baseCanvasSize still used for pan boundary calculations (scaled size at zoom=1)
    setBaseCanvasSize({ width: serverWidth * scale, height: serverHeight * scale });
  }, []);

  // Handle resize/rotate
  useEffect(() => {
    let resizeTimeout = null;
    
    const handleResize = () => {
      // Debounce to ensure container has updated dimensions
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        recalculateDisplaySize();
      }, 100);
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    
    // Also listen for visual viewport changes (iOS Safari)
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleResize);
    }
    
    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", handleResize);
      }
    };
  }, [recalculateDisplaySize]);

  // Accumulate vertical scroll delta and emit to server when threshold reached.
  // Shared by 1-finger direct-mode scroll and 2-finger trackpad-mode scroll.
  const emitScrollFromDelta = useCallback((deltaY) => {
    edgeScrollAccumRef.current.y += deltaY;
    const { edgeScrollThreshold, edgeScrollMultiplier } = REMOTE_CONFIG;
    if (Math.abs(edgeScrollAccumRef.current.y) >= edgeScrollThreshold) {
      const scrollAmount = Math.round(Math.abs(edgeScrollAccumRef.current.y) * edgeScrollMultiplier);
      socketEmitFunctions?.emitScroll(
        edgeScrollAccumRef.current.y > 0 ? "up" : "down",
        Math.max(1, scrollAmount),
        false
      );
      edgeScrollAccumRef.current.y = 0;
    }
  }, [socketEmitFunctions]);

  // Horizontal scroll counterpart — mirrors emitScrollFromDelta for left/right.
  const emitHScrollFromDelta = useCallback((deltaX) => {
    edgeScrollAccumRef.current.x += deltaX;
    const { edgeScrollThreshold, edgeScrollMultiplier } = REMOTE_CONFIG;
    if (Math.abs(edgeScrollAccumRef.current.x) >= edgeScrollThreshold) {
      const scrollAmount = Math.round(Math.abs(edgeScrollAccumRef.current.x) * edgeScrollMultiplier);
      socketEmitFunctions?.emitScroll(
        edgeScrollAccumRef.current.x > 0 ? "right" : "left",
        Math.max(1, scrollAmount),
        true
      );
      edgeScrollAccumRef.current.x = 0;
    }
  }, [socketEmitFunctions]);

  // Emit virtual cursor position as server percentage
  const emitVirtualCursor = useCallback((cursor) => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;
    const percentX = Math.max(0, Math.min(100, (cursor.x / canvas.width) * 100));
    const percentY = Math.max(0, Math.min(100, (cursor.y / canvas.height) * 100));
    socketEmitFunctions?.emitMouseMove?.(percentX, percentY);
  }, [socketEmitFunctions]);

  // ── PC mode: physical mouse handling ──────────────────────────────────────
  // Delegates to existing emitters (emitMousePress/Release/Click/Move, emitScroll)
  // and helpers (getCanvasCoordinates, showClickIndicator, handleSelection).
  // Absolute pointing: canvas coords ARE the remote screen coords — no virtual cursor.
  const handleMouseInteraction = useCallback((event, type, options) => {
    const { streaming, selectionMode, handleSelection } = options;
    if (!streaming || !socketEmitFunctions) return;

    const button = REMOTE_CONFIG.mouseButtonMap[event.button] || "left";

    // ── Wheel: scroll at cursor position, Ctrl+wheel to zoom canvas ─────────
    if (type === "wheel") {
      // scroll-at-cursor: move remote cursor to the wheel position FIRST so the
      // OS applies wheel events to the correct window/widget under the cursor.
      const { percentX, percentY } = getCanvasCoordinates(event.clientX, event.clientY);

      // Normalize delta across deltaMode (0=pixel, 1=line, 2=page).
      const modeMult = event.deltaMode === 1
        ? REMOTE_CONFIG.wheelLineHeight
        : event.deltaMode === 2 ? REMOTE_CONFIG.wheelPageHeight : 1;
      const dy = event.deltaY * modeMult;
      const dx = event.deltaX * modeMult;

      // Ctrl+wheel → zoom canvas locally (like browsers/Figma).
      if (event.ctrlKey || event.metaKey) {
        const container = canvasContainerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;
        const containerRect = container.getBoundingClientRect();
        const focalX = event.clientX - containerRect.left;
        const focalY = event.clientY - containerRect.top;
        setCanvasZoom(prevZoom => {
          const dir = dy > 0 ? -1 : 1;
          const newZoom = Math.max(1, Math.min(4, prevZoom + dir * REMOTE_CONFIG.wheelZoomStep));
          if (newZoom === prevZoom) return prevZoom;
          const zoomRatio = newZoom / prevZoom;
          const canvasDisplayW = baseCanvasSize.width * newZoom;
          const canvasDisplayH = baseCanvasSize.height * newZoom;
          const maxPanX = Math.min(0, container.clientWidth - canvasDisplayW);
          const maxPanY = Math.min(0, container.clientHeight - canvasDisplayH);
          setCanvasPan(prev => ({
            x: Math.max(maxPanX, Math.min(0, focalX - (focalX - prev.x) * zoomRatio)),
            y: Math.max(maxPanY, Math.min(0, focalY - (focalY - prev.y) * zoomRatio))
          }));
          return newZoom;
        });
        return;
      }

      // Normal scroll — mirror touch scroll pipeline exactly (DRY + same perf):
      //   • 1st frame of burst: boostStream + mouseMove ONCE (position wheel target)
      //   • subsequent frames: only emitScrollFromDelta — no mouseMove spam
      //   • end of burst detected by 150ms gap → reset so next scroll re-positions
      if (!wheelActiveRef.current) {
        socketEmitFunctions.emitBoostStream?.();
        socketEmitFunctions.emitMouseMove?.(percentX, percentY);
        wheelActiveRef.current = true;
        wheelLastBoostRef.current = Date.now();
      } else {
        // Re-boost periodically so long bursts (trackpad inertia) stay smooth.
        const now = Date.now();
        if (now - wheelLastBoostRef.current >= REMOTE_CONFIG.wheelBoostInterval) {
          socketEmitFunctions.emitBoostStream?.();
          wheelLastBoostRef.current = now;
        }
      }
      if (wheelEndTimerRef.current) clearTimeout(wheelEndTimerRef.current);
      wheelEndTimerRef.current = setTimeout(() => {
        wheelActiveRef.current = false;
        wheelAccumRef.current.x = 0;
      }, 150);

      const mult = REMOTE_CONFIG.wheelScrollMultiplier;
      // Vertical: native wheel `deltaY > 0 = scroll down`; emitScrollFromDelta
      // treats positive as "up" (matches touch finger-drag-up = page up). Flip sign.
      if (dy) emitScrollFromDelta(-dy * mult);
      if (dx) {
        const { edgeScrollThreshold, edgeScrollMultiplier } = REMOTE_CONFIG;
        wheelAccumRef.current.x += dx * mult;
        if (Math.abs(wheelAccumRef.current.x) >= edgeScrollThreshold) {
          const amount = Math.max(1, Math.round(Math.abs(wheelAccumRef.current.x) * edgeScrollMultiplier));
          socketEmitFunctions.emitScroll?.(wheelAccumRef.current.x > 0 ? "right" : "left", amount, true);
          wheelAccumRef.current.x = 0;
        }
      }
      return;
    }

    // ── Context menu: native right-click ────────────────────────────────────
    if (type === "contextmenu") {
      const { percentX, percentY } = getCanvasCoordinates(event.clientX, event.clientY);
      showClickIndicator(event.clientX, event.clientY);
      socketEmitFunctions.emitMouseClick?.(percentX, percentY, "right");
      return;
    }

    // ── Double-click: DO NOT emit here. press+release (pointerdown/up) already
    // produce two native mouse events at the OS level — the remote OS detects
    // double-click by timing. Emitting dblclick would add a third click.
    if (type === "dblclick") return;

    // ── Selection mode: reuse existing handleSelection logic ────────────────
    if (selectionMode) {
      if (type === "pointerdown") {
        handleSelection?.(event.clientX, event.clientY, "start");
      } else if (type === "pointermove" && mouseDownButtonRef.current != null) {
        handleSelection?.(event.clientX, event.clientY, "move");
      } else if (type === "pointerup") {
        handleSelection?.(event.clientX, event.clientY, "end");
        mouseDownButtonRef.current = null;
      }
      if (type === "pointerdown") mouseDownButtonRef.current = button;
      return;
    }

    // ── Normal drag: press → move (while held) → release ────────────────────
    const { percentX, percentY } = getCanvasCoordinates(event.clientX, event.clientY);

    if (type === "pointerdown") {
      mouseDownButtonRef.current = button;
      showClickIndicator(event.clientX, event.clientY);
      // Use press (not click) so dragging works naturally; a release without move
      // between press and release is a normal click on any OS.
      socketEmitFunctions.emitMousePress?.(percentX, percentY, button);
      return;
    }

    if (type === "pointermove") {
      // Only forward movement while a button is held (drag); plain hover is skipped
      // to avoid flooding, matching desktop OS where hover-only movement is rare.
      if (mouseDownButtonRef.current != null) {
        socketEmitFunctions.emitMouseMove?.(percentX, percentY);
      }
      return;
    }

    if (type === "pointerup") {
      const btn = mouseDownButtonRef.current || button;
      mouseDownButtonRef.current = null;
      socketEmitFunctions.emitMouseRelease?.(percentX, percentY, btn);
      return;
    }
  }, [socketEmitFunctions, getCanvasCoordinates, showClickIndicator, baseCanvasSize, emitScrollFromDelta]);

  // Global pointerup listener — catches release outside the canvas so the remote
  // mouse doesn't get "stuck" in pressed state when the user drags out of bounds.
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
  }, [getCanvasCoordinates, socketEmitFunctions]);

  // Handle canvas interaction
  const handleCanvasInteraction = useCallback((event, type, options) => {
    const {
      streaming, socket, selectionMode, selectionStart,
      dragMode, isDragging, setIsDragging, setDragMode,
      isMobile, handleSelection, pointerMode = "direct",
      handMode = false, onHandRelease
    } = options;

    if (!streaming || !socketEmitFunctions) return;

    // ── PC mode branch: physical mouse / wheel / contextmenu / dblclick ─────
    // Delegated to handleMouseInteraction. Touch flow below is untouched.
    const isMouseEvent = event.nativeEvent?.pointerType === "mouse"
      || event.type === "wheel"
      || event.type === "contextmenu"
      || event.type === "dblclick";
    if (isMouseEvent) {
      // preventDefault selectively: wheel+contextmenu must not bubble to browser.
      if (event.type === "wheel" || event.type === "contextmenu") event.preventDefault();
      return handleMouseInteraction(event, type, options);
    }

    event.preventDefault();

    // Latch multi-touch state — once 2+ fingers touched, stays latched until all fingers up.
    // Prevents virtual cursor from jumping when user lifts one of two fingers mid-gesture.
    if (event.type.startsWith("touch") && event.touches?.length >= 2) {
      multiTouchLatchRef.current = true;
      // Second finger takes over → cancel any pending/active 1-finger long-press
      // (scroll-lock + hand-hold). Otherwise the timer fires mid-zoom/scroll and
      // scroll-lock hijacks the 2-finger gesture. Cancel hard, don't hand back.
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
    // Only active on touch events in trackpad mode; mouse/desktop still direct.
    // Selection mode: anchored at virtual cursor, expands as cursor follows finger.
    if (pointerMode === "trackpad" && event.type.startsWith("touch")) {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width === 0) return;

      // Two-finger gestures: tap = right-click, otherwise fall through to
      // existing pinch-zoom/pan handling below by not returning here.
      if (event.touches?.length >= 2) {
        // Let existing multi-touch block handle zoom; don't inject trackpad logic.
      } else if (!multiTouchLatchRef.current && (event.touches?.length === 1 || type === "touchend")) {
        const touch = event.touches?.[0] || event.changedTouches?.[0];
        if (!touch) return;

        if (type === "touch") {
          touchStartTimeRef.current = Date.now();
          touchTotalMoveRef.current = 0;
          setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
          lastTouchTimeRef.current = Date.now();
          // Selection mode: anchor selection start at virtual cursor (not finger).
          if (selectionMode) {
            const px = (virtualCursor.x / canvas.width) * 100;
            const py = (virtualCursor.y / canvas.height) * 100;
            handleSelection?.(0, 0, "start", { ...options, percentOverride: { percentX: px, percentY: py } });
            return;
          }
          // Hand mode: arm long-press timer to start hold-drag at current cursor.
          // Skip if already holding (instant-hold via toolbar toggle).
          if (handMode && !handHoldingRef.current) {
            if (handLongPressTimerRef.current) clearTimeout(handLongPressTimerRef.current);
            handLongPressTimerRef.current = setTimeout(() => {
              handLongPressTimerRef.current = null;
              const canvasNow = canvasRef.current;
              if (!canvasNow || canvasNow.width === 0) return;
              const px = (virtualCursor.x / canvasNow.width) * 100;
              const py = (virtualCursor.y / canvasNow.height) * 100;
              handHoldingRef.current = true;
              setHandHolding(true);
              vibrate(15);
              socketEmitFunctions.emitMousePress?.(px, py, "left");
            }, REMOTE_CONFIG.longPressDelay);
          }
          // Non-hand mode: arm long-press to enter scroll lock (cursor freezes).
          if (!handMode && !scrollLockRef.current) {
            if (scrollLongPressTimerRef.current) clearTimeout(scrollLongPressTimerRef.current);
            scrollLongPressTimerRef.current = setTimeout(() => {
              scrollLongPressTimerRef.current = null;
              scrollLockRef.current = true;
              setScrollLock(true);
              edgeScrollAccumRef.current = { x: 0, y: 0 };
              vibrate(15);
            }, REMOTE_CONFIG.longPressDelay);
          }
          return;
        }

        if (type === "touchmove") {
          const deltaX = touch.clientX - lastTouchCenter.x;
          const deltaY = touch.clientY - lastTouchCenter.y;
          touchTotalMoveRef.current += Math.abs(deltaX) + Math.abs(deltaY);

          // Scroll lock active: drag scrolls both axes, cursor stays frozen.
          if (scrollLockRef.current) {
            emitScrollFromDelta(deltaY);
            emitHScrollFromDelta(deltaX);
            setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
            lastTouchTimeRef.current = Date.now();
            return;
          }
          // Moved before lock fired → cancel pending scroll long-press (treat as cursor move).
          if (scrollLongPressTimerRef.current &&
              touchTotalMoveRef.current > REMOTE_CONFIG.trackpadTapMaxMove) {
            clearTimeout(scrollLongPressTimerRef.current);
            scrollLongPressTimerRef.current = null;
          }

          // Acceleration based on pointer speed (px/ms)
          const now = Date.now();
          const dt = Math.max(1, now - lastTouchTimeRef.current);
          const speed = Math.sqrt(deltaX * deltaX + deltaY * deltaY) / dt;
          const accel = 1 + Math.min(REMOTE_CONFIG.trackpadAcceleration, speed * REMOTE_CONFIG.trackpadAcceleration);
          const mult = REMOTE_CONFIG.trackpadSensitivity * accel;

          // Convert screen-space delta back to canvas-space (inverse of CSS scale)
          const totalScale = Math.max(0.0001, fitScale * canvasZoom);
          const canvasDeltaX = (deltaX * mult) / totalScale;
          const canvasDeltaY = (deltaY * mult) / totalScale;

          // Selection mode: move virtual cursor with finger, expand rect to new cursor.
          if (selectionMode) {
            setVirtualCursor(prev => {
              const nx = Math.max(0, Math.min(canvas.width - 1, prev.x + canvasDeltaX));
              const ny = Math.max(0, Math.min(canvas.height - 1, prev.y + canvasDeltaY));
              const px = (nx / canvas.width) * 100;
              const py = (ny / canvas.height) * 100;
              emitVirtualCursor({ x: nx, y: ny });
              handleSelection?.(0, 0, "move", { ...options, percentOverride: { percentX: px, percentY: py } });
              return { x: nx, y: ny };
            });
            setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
            lastTouchTimeRef.current = now;
            return;
          }

          // Hand mode: if user started moving before long-press fired, cancel it
          // (treat as drag-without-hold). If already holding, emit mouse-move.
          if (handMode && !handHoldingRef.current && handLongPressTimerRef.current &&
              touchTotalMoveRef.current > REMOTE_CONFIG.trackpadTapMaxMove) {
            clearTimeout(handLongPressTimerRef.current);
            handLongPressTimerRef.current = null;
          }

          setVirtualCursor(prev => {
            const nx = Math.max(0, Math.min(canvas.width - 1, prev.x + canvasDeltaX));
            const ny = Math.max(0, Math.min(canvas.height - 1, prev.y + canvasDeltaY));
            const next = { x: nx, y: ny };
            emitVirtualCursor(next);
            if (handHoldingRef.current) {
              const px = (nx / canvas.width) * 100;
              const py = (ny / canvas.height) * 100;
              socketEmitFunctions.emitMouseMove?.(px, py);
            }

            // Auto-follow pan: keep cursor inside viewport with margin.
            // Only active when canvas is zoomed (pan has room to move).
            const container = canvasContainerRef.current;
            if (container && canvasZoom > 1) {
              const cw = container.clientWidth;
              const ch = container.clientHeight;
              const marginX = cw * REMOTE_CONFIG.trackpadEdgeMarginRatio;
              const marginY = ch * REMOTE_CONFIG.trackpadEdgeMarginRatio;
              const displayW = canvas.width * totalScale;
              const displayH = canvas.height * totalScale;
              const maxPanX = Math.min(0, cw - displayW);
              const maxPanY = Math.min(0, ch - displayH);

              setCanvasPan(p => {
                const screenX = nx * totalScale + p.x;
                const screenY = ny * totalScale + p.y;
                let newPanX = p.x;
                let newPanY = p.y;
                if (screenX < marginX) newPanX = p.x + (marginX - screenX);
                else if (screenX > cw - marginX) newPanX = p.x - (screenX - (cw - marginX));
                if (screenY < marginY) newPanY = p.y + (marginY - screenY);
                else if (screenY > ch - marginY) newPanY = p.y - (screenY - (ch - marginY));
                return {
                  x: Math.max(maxPanX, Math.min(0, newPanX)),
                  y: Math.max(maxPanY, Math.min(0, newPanY))
                };
              });
            }
            return next;
          });

          setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
          lastTouchTimeRef.current = now;
          return;
        }

        if (type === "touchend") {
          // Selection mode: finalize drag-select at virtual cursor.
          if (selectionMode) {
            const px = (virtualCursor.x / canvas.width) * 100;
            const py = (virtualCursor.y / canvas.height) * 100;
            handleSelection?.(0, 0, "end", { ...options, percentOverride: { percentX: px, percentY: py } });
            return;
          }
          // Hand mode: cancel pending long-press, release if holding, then exit hand mode.
          if (handMode) {
            if (handLongPressTimerRef.current) {
              clearTimeout(handLongPressTimerRef.current);
              handLongPressTimerRef.current = null;
            }
            if (handHoldingRef.current) {
              const px = (virtualCursor.x / canvas.width) * 100;
              const py = (virtualCursor.y / canvas.height) * 100;
              socketEmitFunctions.emitMouseRelease?.(px, py, "left");
              handHoldingRef.current = false;
              setHandHolding(false);
              onHandRelease?.();
            }
            return;
          }
          // Scroll lock: clear pending/active lock; skip click on release.
          if (scrollLongPressTimerRef.current) {
            clearTimeout(scrollLongPressTimerRef.current);
            scrollLongPressTimerRef.current = null;
          }
          if (scrollLockRef.current) {
            scrollLockRef.current = false;
            setScrollLock(false);
            edgeScrollAccumRef.current = { x: 0, y: 0 };
            return;
          }
          const duration = Date.now() - touchStartTimeRef.current;
          const isTap = touchTotalMoveRef.current <= REMOTE_CONFIG.trackpadTapMaxMove &&
                        duration <= REMOTE_CONFIG.trackpadTapMaxDuration;
          if (isTap) {
            const percentX = (virtualCursor.x / canvas.width) * 100;
            const percentY = (virtualCursor.y / canvas.height) * 100;
            const isDoubleClick = checkDoubleClick(virtualCursor.x, virtualCursor.y);
            if (dragMode) {
              if (!isDragging) {
                setIsDragging(true);
                socketEmitFunctions.emitMousePress(percentX, percentY, "left");
              } else {
                setIsDragging(false);
                setDragMode(false);
                socketEmitFunctions.emitMouseRelease(percentX, percentY, "left");
              }
            } else {
              socketEmitFunctions.emitMouseClick(percentX, percentY, "left", isDoubleClick);
            }
          }
          return;
        }
      }
    }

    // Multi-touch zoom/scroll — with gesture intent locking
    if (event.type.startsWith("touch") && event.touches?.length >= 2 && !selectionMode) {
      const distance = getTouchDistance(event.touches);
      const center = getTouchCenter(event.touches);

      if (type === "touch") {
        setIsZooming(true);
        setLastTouchDistance(distance);
        setLastTouchCenter(center);
        // Initialize gesture lock
        gestureLockRef.current = null;
        gestureStartRef.current = {
          time: Date.now(),
          distance,
          centerX: center.x,
          centerY: center.y
        };
        twoFingerMaxMovedRef.current = 0;
        return;
      } else if (type === "touchmove" && isZooming) {
        const container = canvasContainerRef.current;
        if (!container) return;

        // Determine gesture intent if not locked yet
        if (gestureLockRef.current === null) {
          const elapsed = Date.now() - gestureStartRef.current.time;
          const deltaDistance = Math.abs(distance - gestureStartRef.current.distance);
          const deltaCentroid = Math.sqrt(
            (center.x - gestureStartRef.current.centerX) ** 2 +
            (center.y - gestureStartRef.current.centerY) ** 2
          );
          // Track max movement for 2-finger tap detection on touchend.
          twoFingerMaxMovedRef.current = Math.max(
            twoFingerMaxMovedRef.current,
            deltaDistance,
            deltaCentroid
          );
          const {
            gestureLockDelay,
            gestureDistanceThreshold,
            gestureCentroidThreshold,
            gestureDominanceRatio
          } = REMOTE_CONFIG;

          // Wait for clear intent (either enough time passed OR threshold clearly crossed)
          const hasZoomSignal = deltaDistance >= gestureDistanceThreshold;
          const hasScrollSignal = deltaCentroid >= gestureCentroidThreshold;

          if (hasZoomSignal || hasScrollSignal || elapsed >= gestureLockDelay) {
            const ratio = deltaCentroid > 0.5 ? deltaDistance / deltaCentroid : Infinity;
            if (ratio >= gestureDominanceRatio && hasZoomSignal) {
              gestureLockRef.current = "zoom";
            } else if (ratio <= 1 / gestureDominanceRatio && hasScrollSignal) {
              gestureLockRef.current = "scroll";
            } else if (hasZoomSignal && !hasScrollSignal) {
              gestureLockRef.current = "zoom";
            } else if (hasScrollSignal && !hasZoomSignal) {
              gestureLockRef.current = "scroll";
            }
            // Still ambiguous → keep waiting (null)
          }
        }

        // Scroll mode: reuse the same scroll logic as 1-finger direct mode.
        // Anchor scroll position so the wheel event targets the correct spot:
        //   • Trackpad mode: virtual cursor (where the ✋ icon is).
        //   • Direct mode:   2-finger centroid (where the user's fingers actually are).
        // Then emit scroll based on vertical centroid delta.
        if (gestureLockRef.current === "scroll") {
          const deltaY = center.y - lastTouchCenter.y;
          // Emit mouse move to anchor on first scroll frame so wheel event targets correct location
          if (!isEdgeScrolling) {
            const canvasNow = canvasRef.current;
            const coords = (pointerMode === "trackpad" && canvasNow && canvasNow.width > 0)
              ? {
                  percentX: (virtualCursor.x / canvasNow.width) * 100,
                  percentY: (virtualCursor.y / canvasNow.height) * 100
                }
              : getCanvasCoordinates(center.x, center.y);
            socketEmitFunctions?.emitBoostStream?.();
            socketEmitFunctions?.emitMouseMove?.(coords.percentX, coords.percentY);
            setIsEdgeScrolling(true);
          }
          emitScrollFromDelta(deltaY);
          setLastTouchDistance(distance);
          setLastTouchCenter(center);
          return;
        }

        // Zoom mode (or still ambiguous): pinch-zoom canvas
        if (gestureLockRef.current === "zoom" || gestureLockRef.current === null) {
          const containerRect = container.getBoundingClientRect();
          const containerWidth = container.clientWidth;
          const containerHeight = container.clientHeight;

          // Focal point relative to container
          const focalX = center.x - containerRect.left;
          const focalY = center.y - containerRect.top;

          if (lastTouchDistance > 0 && gestureLockRef.current === "zoom") {
            const scale = distance / lastTouchDistance;
            const oldZoom = canvasZoom;
            const newZoom = Math.max(1, Math.min(4, oldZoom * scale));

            const zoomRatio = newZoom / oldZoom;
            const canvasDisplayWidth = baseCanvasSize.width * newZoom;
            const canvasDisplayHeight = baseCanvasSize.height * newZoom;
            const maxPanX = Math.min(0, containerWidth - canvasDisplayWidth);
            const maxPanY = Math.min(0, containerHeight - canvasDisplayHeight);

            setCanvasPan(prev => {
              const newPanX = focalX - (focalX - prev.x) * zoomRatio;
              const newPanY = focalY - (focalY - prev.y) * zoomRatio;
              return {
                x: Math.max(maxPanX, Math.min(0, newPanX)),
                y: Math.max(maxPanY, Math.min(0, newPanY))
              };
            });

            setCanvasZoom(newZoom);
            setLastTouchDistance(distance);
          }
        }

        setLastTouchCenter(center);
        return;
      }
    }

    // Single touch handling
    if (event.type.startsWith("touch") && event.touches?.length === 1) {
      const touch = event.touches[0];

      // Skip single touch processing if was just zooming (transitioning from 2 fingers to 1)
      if (isZooming) {
        setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
        return;
      }

      if (type === "touch") {
        setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
        lastTouchTimeRef.current = Date.now();
        velocityRef.current = { x: 0, y: 0 };
        edgeScrollAccumRef.current = { x: 0, y: 0 };
        stopMomentum();
        
        if (selectionMode) {
          handleSelection(touch.clientX, touch.clientY, "start");
        } else if (!dragMode) {
          // Start long-press detection for right-click
          const { percentX, percentY } = getCanvasCoordinates(touch.clientX, touch.clientY);
          startLongPress(touch.clientX, touch.clientY, percentX, percentY);
        }
        return;
      } else if (type === "touchmove") {
        // Cancel long-press if moved too much
        const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
        const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
        if (dx > REMOTE_CONFIG.moveThreshold || dy > REMOTE_CONFIG.moveThreshold) {
          cancelLongPress();
        }
        
        if (selectionMode && selectionStart) {
          handleSelection(touch.clientX, touch.clientY, "move");
          return;
        }

        if (!selectionMode && !dragMode) {
          const deltaX = touch.clientX - lastTouchCenter.x;
          const deltaY = touch.clientY - lastTouchCenter.y;
          
          // Calculate velocity for momentum
          const now = Date.now();
          const dt = now - lastTouchTimeRef.current;
          if (dt > 0) {
            velocityRef.current = {
              x: deltaX / dt * 16, // Normalize to ~60fps frame
              y: deltaY / dt * 16
            };
            lastTouchTimeRef.current = now;
          }

          if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
            cancelLongPress();
            const touchCoords = getCanvasCoordinates(touch.clientX, touch.clientY);

            // Only scroll vertically when swipe is predominantly vertical
            const isVerticalSwipe = Math.abs(deltaY) > Math.abs(deltaX) * 1.5;

            // Helper: init scroll state (emit mouseMove once) then accumulate delta
            const processScroll = (overflowY) => {
              if (!isVerticalSwipe) return;
              if (!isEdgeScrolling) {
                socketEmitFunctions?.emitBoostStream?.();
                socketEmitFunctions?.emitMouseMove?.(touchCoords.percentX, touchCoords.percentY);
                setIsEdgeScrolling(true);
              }
              emitScrollFromDelta(overflowY);
            };

            // When zoom = 1: direct vertical scroll (like 2-finger on macbook)
            if (canvasZoom === 1) {
              if (isVerticalSwipe) {
                processScroll(deltaY);
              }
              setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
              return;
            }
            
            // Zoom > 1: Pan first, edge scroll only when fully at edge
            setIsPanning(true);
            const canvasDisplayWidth = baseCanvasSize.width * canvasZoom;
            const canvasDisplayHeight = baseCanvasSize.height * canvasZoom;
            const containerWidth = canvasContainerRef.current?.clientWidth || 0;
            const containerHeight = canvasContainerRef.current?.clientHeight || 0;
            const maxPanX = Math.min(0, containerWidth - canvasDisplayWidth);
            const maxPanY = Math.min(0, containerHeight - canvasDisplayHeight);

            setCanvasPan(prev => {
              const newX = Math.max(maxPanX, Math.min(0, prev.x + deltaX));
              const newY = Math.max(maxPanY, Math.min(0, prev.y + deltaY));
              
              // Check if vertical pan actually moved (not stuck at edge)
              const panMovedY = Math.abs(newY - prev.y) > 0.5;
              
              // Only scroll if pan is completely stuck at vertical edge
              const overflowY = !panMovedY ? (prev.y + deltaY) - newY : 0;
              
              if (Math.abs(overflowY) > 0) {
                processScroll(overflowY);
              } else {
                edgeScrollAccumRef.current.y = 0;
                setIsEdgeScrolling(false);
              }
              
              return { x: newX, y: newY };
            });
            setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
          }
          return;
        }
      }
    }

    // Touch end
    if (type === "touchend") {
      cancelLongPress();

      // 2-finger tap → right-click at virtual cursor (trackpad mode only).
      // Must run BEFORE resetting gestureLockRef. Fire only when the gesture never
      // committed to zoom/scroll AND movement+duration stay within tap thresholds.
      if (pointerMode === "trackpad" && isZooming &&
          (event.touches?.length || 0) === 0 &&
          gestureLockRef.current === null &&
          Date.now() - gestureStartRef.current.time <= REMOTE_CONFIG.trackpadTapMaxDuration &&
          twoFingerMaxMovedRef.current <= REMOTE_CONFIG.trackpadTapMaxMove) {
        const canvasNow = canvasRef.current;
        if (canvasNow && canvasNow.width > 0 && socketEmitFunctions?.emitMouseClick) {
          const px = (virtualCursor.x / canvasNow.width) * 100;
          const py = (virtualCursor.y / canvasNow.height) * 100;
          socketEmitFunctions.emitMouseClick(px, py, "right");
          vibrate(15);
        }
      }

      gestureLockRef.current = null;
      // Release multi-touch latch only when ALL fingers are lifted
      if ((event.touches?.length || 0) === 0) {
        multiTouchLatchRef.current = false;
      }
      const wasZooming = isZooming;
      const wasPanning = isPanning;
      const wasEdgeScrolling = isEdgeScrolling;
      const wasLongPress = longPressTriggeredRef.current;
      longPressTriggeredRef.current = false;

      if (wasZooming) {
        setRecentZoomGesture(true);
        if (zoomGestureTimeoutRef.current) {
          clearTimeout(zoomGestureTimeoutRef.current);
        }
        zoomGestureTimeoutRef.current = setTimeout(() => {
          setRecentZoomGesture(false);
        }, 200);
      }

      // Start momentum scroll if was edge scrolling with velocity
      if (wasEdgeScrolling && (Math.abs(velocityRef.current.x) > REMOTE_CONFIG.momentumMinVelocity || 
          Math.abs(velocityRef.current.y) > REMOTE_CONFIG.momentumMinVelocity)) {
        startMomentumScroll();
      } else {
        stopMomentum();
      }

      setIsZooming(false);
      setIsPanning(false);

      // Skip click if was zooming, panning, edge scrolling, or long-press already triggered
      if (wasZooming || wasPanning || wasEdgeScrolling || recentZoomGesture || wasLongPress) return;

      if (event.type.startsWith("touch")) {
        const touch = event.changedTouches?.[0];
        if (touch) {
          if (selectionMode) {
            handleSelection(touch.clientX, touch.clientY, "end");
          } else {
            const { percentX, percentY } = getCanvasCoordinates(touch.clientX, touch.clientY);
            showClickIndicator(touch.clientX, touch.clientY);

            if (dragMode) {
              if (!isDragging) {
                setIsDragging(true);
                socketEmitFunctions.emitMousePress(percentX, percentY, "left");
              } else {
                setIsDragging(false);
                setDragMode(false);
                socketEmitFunctions.emitMouseRelease(percentX, percentY, "left");
              }
            } else {
              // Check for double-click
              const isDoubleClick = checkDoubleClick(touch.clientX, touch.clientY);
              if (isDoubleClick) {
                socketEmitFunctions.emitMouseClick(percentX, percentY, "left", true);
              } else {
                socketEmitFunctions.emitMouseClick(percentX, percentY, "left");
              }
            }
          }
        }
      }
      return;
    }

    if (isZooming || isPanning) return;

    // Mouse events
    let clientX, clientY;
    if (event.type.startsWith("touch")) {
      if (event.touches?.length !== 1) return;
      clientX = event.touches[0].clientX;
      clientY = event.touches[0].clientY;
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }

    const { percentX, percentY } = getCanvasCoordinates(clientX, clientY);

    if (type === "click") {
      if (selectionMode) {
        if (!selectionStart) {
          handleSelection(clientX, clientY, "start");
        } else {
          handleSelection(clientX, clientY, "end");
        }
      } else {
        showClickIndicator(clientX, clientY);
        if (dragMode) {
          if (!isDragging) {
            setIsDragging(true);
            socketEmitFunctions.emitMousePress(percentX, percentY, "left");
          } else {
            setIsDragging(false);
            setDragMode(false);
            socketEmitFunctions.emitMouseRelease(percentX, percentY, "left");
          }
        } else {
          // Check for double-click (desktop)
          const isDoubleClick = checkDoubleClick(clientX, clientY);
          if (isDoubleClick) {
            socketEmitFunctions.emitMouseClick(percentX, percentY, "left", true);
          } else {
            socketEmitFunctions.emitMouseClick(percentX, percentY, "left");
          }
        }
      }
    } else if (type === "move" && !isMobile) {
      if (selectionMode && selectionStart) {
        handleSelection(clientX, clientY, "move");
        return;
      }
      socketEmitFunctions.emitMouseMove(percentX, percentY);
    }
  }, [
    isZooming, isPanning, isEdgeScrolling, canvasZoom, lastTouchDistance, lastTouchCenter,
    baseCanvasSize, recentZoomGesture, fitScale, virtualCursor, getCanvasCoordinates, showClickIndicator,
    getTouchDistance, getTouchCenter, socketEmitFunctions, cancelLongPress,
    startLongPress, checkDoubleClick, stopMomentum, startMomentumScroll, emitVirtualCursor,
    emitScrollFromDelta, emitHScrollFromDelta, handleMouseInteraction
  ]);

  // Handle canvas dimensions from server
  const handleCanvasDimensions = useCallback((dimensions, renderedTilesRef) => {
    // Persist BEFORE the canvas guard so a late-mounting canvas can still apply them
    // (iOS may deliver dimensions before the <canvas> commits after a background purge).
    serverDimensionsRef.current = { width: dimensions.width, height: dimensions.height };

    const canvas = canvasRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !container) return false;

    const dimensionsChanged = canvas.width !== dimensions.width || canvas.height !== dimensions.height;

    canvas.width = dimensions.width;
    canvas.height = dimensions.height;

    // Set once — survives canvas resize (width/height reset clears ctx state)
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    if (dimensionsChanged) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (renderedTilesRef?.current) {
        renderedTilesRef.current.clear();
      }
    }

    // Calculate display size
    recalculateDisplaySize();
    return dimensionsChanged;
  }, [recalculateDisplaySize]);

  // Center virtual cursor whenever canvas dimensions change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;
    setVirtualCursor(prev => {
      if (prev.x === 0 && prev.y === 0) {
        return { x: canvas.width / 2, y: canvas.height / 2 };
      }
      return prev;
    });
  }, [baseCanvasSize]);

  // Move virtual cursor to the center of the VISIBLE viewport (not full canvas).
  // When zoomed, only part of canvas is visible — cursor should appear where user is looking.
  const centerVirtualCursor = useCallback(() => {
    const canvas = canvasRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !container || canvas.width === 0) return;
    const totalScale = fitScale * canvasZoom;
    if (totalScale <= 0) return;
    // Reverse pan + scale: center of container (in screen) → canvas pixel coord
    const cx = (container.clientWidth / 2 - canvasPan.x) / totalScale;
    const cy = (container.clientHeight / 2 - canvasPan.y) / totalScale;
    setVirtualCursor({
      x: Math.max(0, Math.min(canvas.width - 1, cx)),
      y: Math.max(0, Math.min(canvas.height - 1, cy))
    });
  }, [fitScale, canvasZoom, canvasPan]);

  // Start hand-hold immediately at current virtual cursor (instant-hold, no long-press).
  // Emits boost-stream + mouse press "left" and flips holding state.
  const startHandHold = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;
    if (handHoldingRef.current) return;
    if (handLongPressTimerRef.current) {
      clearTimeout(handLongPressTimerRef.current);
      handLongPressTimerRef.current = null;
    }
    const px = (virtualCursor.x / canvas.width) * 100;
    const py = (virtualCursor.y / canvas.height) * 100;
    handHoldingRef.current = true;
    setHandHolding(true);
    vibrate(15);
    socketEmitFunctions?.emitBoostStream?.();
    socketEmitFunctions?.emitMousePress?.(px, py, "left");
  }, [virtualCursor, socketEmitFunctions]);

  // Manual release (when user toggles hand mode OFF while still holding, without touchend).
  const releaseHandHold = useCallback(() => {
    if (!handHoldingRef.current) return;
    const canvas = canvasRef.current;
    const px = canvas && canvas.width > 0 ? (virtualCursor.x / canvas.width) * 100 : 0;
    const py = canvas && canvas.height > 0 ? (virtualCursor.y / canvas.height) * 100 : 0;
    socketEmitFunctions?.emitMouseRelease?.(px, py, "left");
    handHoldingRef.current = false;
    setHandHolding(false);
  }, [virtualCursor, socketEmitFunctions]);

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
    resetZoom,
    panForKeyboard,
    centerVirtualCursor,
    startHandHold,
    releaseHandHold,
    handleCanvasInteraction,
    handleCanvasDimensions,
    serverDimensionsRef
  };
}
