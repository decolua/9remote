"use client";

import { useRef, useState, useCallback, useEffect } from "react";

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
  const [recentZoomGesture, setRecentZoomGesture] = useState(false);
  const zoomGestureTimeoutRef = useRef(null);
  const [clickIndicator, setClickIndicator] = useState(null);

  // Get percentage-based coordinates
  const getCanvasCoordinates = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !container || baseCanvasSize.width === 0) {
      return { percentX: 0, percentY: 0 };
    }

    const containerRect = container.getBoundingClientRect();
    const containerX = clientX - containerRect.left;
    const containerY = clientY - containerRect.top;
    const unPannedX = containerX - canvasPan.x;
    const unPannedY = containerY - canvasPan.y;
    const transformedX = unPannedX / canvasZoom;
    const transformedY = unPannedY / canvasZoom;
    const percentX = (transformedX / baseCanvasSize.width) * 100;
    const percentY = (transformedY / baseCanvasSize.height) * 100;

    return {
      percentX: Math.max(0, Math.min(100, percentX)),
      percentY: Math.max(0, Math.min(100, percentY))
    };
  }, [canvasPan, canvasZoom, baseCanvasSize]);

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

    setClickIndicator({ x, y, size });
    setTimeout(() => setClickIndicator(null), 500);
  }, [canvasZoom]);

  const resetZoom = useCallback(() => {
    setCanvasZoom(1);
    setCanvasPan({ x: 0, y: 0 });
  }, []);

  // Initialize canvas size
  useEffect(() => {
    const handleResize = () => {
      const container = canvasContainerRef.current;
      if (container) {
        const { width, height } = container.getBoundingClientRect();
        setBaseCanvasSize(prev => {
          if (prev.width === 0 && prev.height === 0) {
            return { width: Math.max(width, 1920), height: Math.max(height, 1080) };
          }
          return prev;
        });
      }
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Handle canvas interaction
  const handleCanvasInteraction = useCallback((event, type, options) => {
    const {
      streaming, socket, selectionMode, selectionStart,
      dragMode, isDragging, setIsDragging, setDragMode,
      isMobile, handleSelection
    } = options;

    if (!streaming || !socketEmitFunctions) return;
    event.preventDefault();

    // Multi-touch zoom/pan
    if (event.type.startsWith("touch") && event.touches?.length >= 2 && !selectionMode) {
      const distance = getTouchDistance(event.touches);
      const center = getTouchCenter(event.touches);

      if (type === "touch") {
        setIsZooming(true);
        setLastTouchDistance(distance);
        setLastTouchCenter(center);
        return;
      } else if (type === "touchmove" && isZooming) {
        if (lastTouchDistance > 0) {
          const scale = distance / lastTouchDistance;
          setCanvasZoom(prev => Math.max(1, Math.min(4, prev * scale)));
          setLastTouchDistance(distance);
        }

        const deltaX = center.x - lastTouchCenter.x;
        const deltaY = center.y - lastTouchCenter.y;
        const canvasDisplayWidth = baseCanvasSize.width * canvasZoom;
        const canvasDisplayHeight = baseCanvasSize.height * canvasZoom;
        const containerWidth = canvasContainerRef.current?.clientWidth || 0;
        const containerHeight = canvasContainerRef.current?.clientHeight || 0;
        const maxPanX = Math.min(0, containerWidth - canvasDisplayWidth);
        const maxPanY = Math.min(0, containerHeight - canvasDisplayHeight);

        setCanvasPan(prev => ({
          x: Math.max(maxPanX, Math.min(0, prev.x + deltaX)),
          y: Math.max(maxPanY, Math.min(0, prev.y + deltaY))
        }));
        setLastTouchCenter(center);
        return;
      }
    }

    // Single touch handling
    if (event.type.startsWith("touch") && event.touches?.length === 1) {
      const touch = event.touches[0];

      if (type === "touch") {
        setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
        if (selectionMode) {
          handleSelection(touch.clientX, touch.clientY, "start");
        }
        return;
      } else if (type === "touchmove") {
        if (selectionMode && selectionStart) {
          handleSelection(touch.clientX, touch.clientY, "move");
          return;
        }

        if (canvasZoom > 1 && !selectionMode) {
          const deltaX = touch.clientX - lastTouchCenter.x;
          const deltaY = touch.clientY - lastTouchCenter.y;

          if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
            setIsPanning(true);
            const canvasDisplayWidth = baseCanvasSize.width * canvasZoom;
            const canvasDisplayHeight = baseCanvasSize.height * canvasZoom;
            const containerWidth = canvasContainerRef.current?.clientWidth || 0;
            const containerHeight = canvasContainerRef.current?.clientHeight || 0;
            const maxPanX = Math.min(0, containerWidth - canvasDisplayWidth);
            const maxPanY = Math.min(0, containerHeight - canvasDisplayHeight);

            setCanvasPan(prev => ({
              x: Math.max(maxPanX, Math.min(0, prev.x + deltaX)),
              y: Math.max(maxPanY, Math.min(0, prev.y + deltaY))
            }));
            setLastTouchCenter({ x: touch.clientX, y: touch.clientY });
          }
          return;
        }
      }
    }

    // Touch end
    if (type === "touchend") {
      const wasZooming = isZooming;
      const wasPanning = isPanning;

      if (wasZooming) {
        setRecentZoomGesture(true);
        if (zoomGestureTimeoutRef.current) {
          clearTimeout(zoomGestureTimeoutRef.current);
        }
        zoomGestureTimeoutRef.current = setTimeout(() => {
          setRecentZoomGesture(false);
        }, 200);
      }

      setIsZooming(false);
      setIsPanning(false);

      if (wasZooming || wasPanning || recentZoomGesture) return;

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
              socketEmitFunctions.emitMouseClick(percentX, percentY, "left");
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
          socketEmitFunctions.emitMouseClick(percentX, percentY, "left");
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
    isZooming, isPanning, canvasZoom, lastTouchDistance, lastTouchCenter,
    baseCanvasSize, recentZoomGesture, getCanvasCoordinates, showClickIndicator,
    getTouchDistance, getTouchCenter, socketEmitFunctions
  ]);

  // Handle canvas dimensions from server
  const handleCanvasDimensions = useCallback((dimensions, renderedTilesRef) => {
    const canvas = canvasRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !container) return false;

    const dimensionsChanged = canvas.width !== dimensions.width || canvas.height !== dimensions.height;

    canvas.width = dimensions.width;
    canvas.height = dimensions.height;

    const containerWidth = container.clientWidth;
    const initialScale = containerWidth / dimensions.width;
    const displayWidth = containerWidth;
    const displayHeight = dimensions.height * initialScale;

    if (dimensionsChanged) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (renderedTilesRef?.current) {
        renderedTilesRef.current.clear();
      }
    }

    setBaseCanvasSize({ width: displayWidth, height: displayHeight });
    return dimensionsChanged;
  }, []);

  return {
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
  };
}
