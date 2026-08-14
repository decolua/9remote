"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import {
  toCanvasPoint, toPercentPoint, maxPanFor, clampPan, fitScaleFor, keyboardPanTarget
} from "@/features/remote/lib/canvasGeometry";

// Canvas viewport: server dimensions, fit scale, zoom/pan state and their clamping.
// Owns the resize/orientation pipeline; input gestures live in useCanvas.
export function useCanvasViewport() {
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);

  const [canvasZoom, setCanvasZoom] = useState(1);
  const [canvasPan, setCanvasPan] = useState({ x: 0, y: 0 });
  // fitScale: CSS scale to fit server canvas into container at zoom=1
  const [fitScale, setFitScale] = useState(1);
  const [baseCanvasSize, setBaseCanvasSize] = useState({ width: 0, height: 0 });
  const serverDimensionsRef = useRef({ width: 0, height: 0 });
  // Last interaction point in SERVER canvas pixels — keeps the touched spot visible
  // when the on-screen keyboard opens (auto-pan).
  const lastInteractPxRef = useRef({ x: 0, y: 0 });

  const totalScale = fitScale * canvasZoom;

  const containerSize = useCallback(() => {
    const c = canvasContainerRef.current;
    return c ? { width: c.clientWidth, height: c.clientHeight } : null;
  }, []);

  const displaySizeAt = useCallback(
    (zoom) => ({ width: baseCanvasSize.width * zoom, height: baseCanvasSize.height * zoom }),
    [baseCanvasSize]
  );

  // Screen coords → clamped server percentages
  const getCanvasCoordinates = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !container || canvas.width === 0) return { percentX: 0, percentY: 0 };

    const point = toCanvasPoint({
      clientX, clientY,
      containerRect: container.getBoundingClientRect(),
      pan: canvasPan,
      totalScale: fitScale * canvasZoom
    });
    return toPercentPoint({ canvasPoint: point, canvasWidth: canvas.width, canvasHeight: canvas.height });
  }, [canvasPan, canvasZoom, fitScale]);

  const recordInteractPx = useCallback((containerX, containerY) => {
    const scale = fitScale * canvasZoom;
    if (scale <= 0) return;
    lastInteractPxRef.current = {
      x: (containerX - canvasPan.x) / scale,
      y: (containerY - canvasPan.y) / scale
    };
  }, [fitScale, canvasZoom, canvasPan]);

  const resetZoom = useCallback(() => {
    setCanvasZoom(1);
    setCanvasPan({ x: 0, y: 0 });
  }, []);

  // Pan-only reset — zoom is a ratio so it survives a canvas resize, but pan is
  // absolute px against the old canvas and would point off-screen on a new one.
  const resetPan = useCallback(() => setCanvasPan({ x: 0, y: 0 }), []);

  // Keyboard auto-pan: the container shrinks from the bottom when the on-screen keyboard
  // opens. At zoom>1 the point of interest can fall behind it — re-pan so it sits ~1/3
  // down the visible area. On close, re-clamp to a valid pan.
  // targetPx: point to keep visible, in server px (trackpad passes the virtual cursor;
  // other modes fall back to the last tapped point).
  const panForKeyboard = useCallback((active, targetPx) => {
    const size = containerSize();
    if (!size) return;
    const scale = fitScale * canvasZoom;
    if (scale <= 0) return;

    const focus = targetPx || lastInteractPxRef.current;
    const maxPan = maxPanFor(size, displaySizeAt(canvasZoom));

    setCanvasPan(prev => {
      if (!active || canvasZoom <= 1) return clampPan(prev, maxPan);
      const { y } = keyboardPanTarget({ focus, containerHeight: size.height, totalScale: scale });
      return clampPan({ x: prev.x, y }, maxPan);
    });
  }, [containerSize, displaySizeAt, fitScale, canvasZoom]);

  // Recalculate fitScale: CSS scale that fits server canvas into container at zoom=1
  const recalculateDisplaySize = useCallback(() => {
    const container = canvasContainerRef.current;
    const canvas = canvasRef.current;
    const server = serverDimensionsRef.current;
    if (!container || !canvas || server.width === 0 || server.height === 0) return;

    const size = { width: container.clientWidth, height: container.clientHeight };
    const scale = fitScaleFor(size, server);
    setFitScale(scale);
    // baseCanvasSize is the scaled size at zoom=1 — used for pan boundary math
    setBaseCanvasSize({ width: server.width * scale, height: server.height * scale });
  }, []);

  // Handle resize/rotate. Debounce collapses the burst (resize + orientationchange +
  // visualViewport.resize fire in one turn), then an rAF poll waits for the container to
  // actually stabilize before recomputing fitScale — the layout flip straddles the debounce
  // on Android Chrome, and a mid-transition width picks a wrong scale.
  useEffect(() => {
    let resizeTimeout = null;
    let rafId = null;

    const pollAndRecalculate = () => {
      const container = canvasContainerRef.current;
      if (!container) { recalculateDisplaySize(); return; }

      let lastW = container.clientWidth;
      let lastH = container.clientHeight;
      let stable = 0;
      let tries = 0;

      const tick = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === lastW && h === lastH) {
          if (++stable >= REMOTE_CONFIG.resizeStableFrames) {
            rafId = null;
            recalculateDisplaySize();
            return;
          }
        } else {
          stable = 0;
          lastW = w;
          lastH = h;
        }
        if (tries++ >= REMOTE_CONFIG.resizeMaxFrames) {
          rafId = null;
          recalculateDisplaySize();
          return;
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    };

    const handleResize = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      resizeTimeout = setTimeout(pollAndRecalculate, REMOTE_CONFIG.resizeDebounceMs);
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", handleResize);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", handleResize);
    };
  }, [recalculateDisplaySize]);

  // Re-clamp pan whenever display size or zoom changes (orientation, container resize,
  // server dims change) so pan can't go stale when visualViewport.resize doesn't fire.
  useEffect(() => {
    setCanvasPan(prev => {
      const container = canvasContainerRef.current;
      if (!container) return prev;
      const size = { width: container.clientWidth, height: container.clientHeight };
      const display = { width: baseCanvasSize.width * canvasZoom, height: baseCanvasSize.height * canvasZoom };
      const next = clampPan(prev, maxPanFor(size, display));
      return next.x === prev.x && next.y === prev.y ? prev : next;
    });
  }, [baseCanvasSize, canvasZoom]);

  // Apply server-reported canvas dimensions; returns true when they changed
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
      if (renderedTilesRef?.current) renderedTilesRef.current.clear();
    }

    recalculateDisplaySize();
    return dimensionsChanged;
  }, [recalculateDisplaySize]);

  return {
    canvasRef,
    canvasContainerRef,
    canvasZoom,
    setCanvasZoom,
    canvasPan,
    setCanvasPan,
    fitScale,
    totalScale,
    baseCanvasSize,
    serverDimensionsRef,
    containerSize,
    displaySizeAt,
    getCanvasCoordinates,
    recordInteractPx,
    resetZoom,
    resetPan,
    panForKeyboard,
    handleCanvasDimensions
  };
}
