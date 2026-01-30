"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";

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
  
  // Long-press and double-click detection
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const touchStartPosRef = useRef({ x: 0, y: 0 });
  const lastClickTimeRef = useRef(0);
  const lastClickPosRef = useRef({ x: 0, y: 0 });
  
  // Store server dimensions for recalculation on resize
  const serverDimensionsRef = useRef({ width: 0, height: 0 });
  
  // Edge scroll with momentum
  const [isEdgeScrolling, setIsEdgeScrolling] = useState(false);
  const edgeScrollAccumRef = useRef({ x: 0, y: 0 });
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastTouchTimeRef = useRef(0);
  const momentumFrameRef = useRef(null);

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

  // Recalculate display size based on container and server dimensions
  // Always maximize one dimension to 100% while maintaining aspect ratio
  const recalculateDisplaySize = useCallback(() => {
    const container = canvasContainerRef.current;
    const serverWidth = serverDimensionsRef.current.width;
    const serverHeight = serverDimensionsRef.current.height;
    
    if (!container || serverWidth === 0 || serverHeight === 0) return;
    
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const serverAspect = serverWidth / serverHeight;
    const containerAspect = containerWidth / containerHeight;
    
    let displayWidth, displayHeight;
    
    if (containerAspect > serverAspect) {
      // Container is wider than server aspect → height = 100%, calculate width
      displayHeight = containerHeight;
      displayWidth = containerHeight * serverAspect;
    } else {
      // Container is taller than server aspect → width = 100%, calculate height
      displayWidth = containerWidth;
      displayHeight = containerWidth / serverAspect;
    }
    
    setBaseCanvasSize({ width: displayWidth, height: displayHeight });
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
            
            // Helper: process accumulated vertical scroll only
            const processScroll = (overflowY) => {
              if (!isVerticalSwipe) return; // Skip if not vertical swipe
              
              edgeScrollAccumRef.current.y += overflowY;
              
              if (!isEdgeScrolling) {
                socketEmitFunctions?.emitBoostStream?.();
                socketEmitFunctions?.emitMouseMove?.(touchCoords.percentX, touchCoords.percentY);
                setIsEdgeScrolling(true);
              }
              
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
    baseCanvasSize, recentZoomGesture, getCanvasCoordinates, showClickIndicator,
    getTouchDistance, getTouchCenter, socketEmitFunctions, cancelLongPress,
    startLongPress, checkDoubleClick, stopMomentum, startMomentumScroll
  ]);

  // Handle canvas dimensions from server
  const handleCanvasDimensions = useCallback((dimensions, renderedTilesRef) => {
    const canvas = canvasRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !container) return false;

    const dimensionsChanged = canvas.width !== dimensions.width || canvas.height !== dimensions.height;

    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    
    // Store server dimensions for recalculation on resize
    serverDimensionsRef.current = { width: dimensions.width, height: dimensions.height };

    if (dimensionsChanged) {
      const ctx = canvas.getContext("2d");
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
