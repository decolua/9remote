import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { clamp, zoomAtFocal, wheelModeMultiplier, accumulateScrollDelta } from "@/features/remote/lib/canvasGeometry";

const MAX_ZOOM = 4;

// PC mode: physical mouse / wheel / contextmenu / dblclick.
// Absolute pointing — canvas coords ARE the remote screen coords, no virtual cursor.
// Delegates to ctx emitters (emitMousePress/Release/Click/Move, emitScroll) and helpers
// (getCanvasCoordinates, showClickIndicator). ctx: see useCanvas.
export function handleMouseEvent(ctx, event, type, options) {
  const { socketEmitFunctions, getCanvasCoordinates, showClickIndicator } = ctx;
  const { streaming, selectionMode, handleSelection } = options;
  if (!streaming || !socketEmitFunctions) return;

  const button = REMOTE_CONFIG.mouseButtonMap[event.button] || "left";

  // ── Wheel: scroll at cursor position, Ctrl+wheel to zoom canvas ─────────
  if (type === "wheel") {
    // scroll-at-cursor: move the remote cursor to the wheel position FIRST so the OS
    // applies wheel events to the window/widget under it.
    const { percentX, percentY } = getCanvasCoordinates(event.clientX, event.clientY);

    const modeMult = wheelModeMultiplier(event.deltaMode, REMOTE_CONFIG);
    const dy = event.deltaY * modeMult;
    const dx = event.deltaX * modeMult;

    // Ctrl+wheel → zoom canvas locally (like browsers/Figma)
    if (event.ctrlKey || event.metaKey) {
      const container = ctx.canvasContainerRef.current;
      const canvas = ctx.canvasRef.current;
      if (!container || !canvas) return;
      const containerRect = container.getBoundingClientRect();
      const focal = { x: event.clientX - containerRect.left, y: event.clientY - containerRect.top };
      const size = { width: container.clientWidth, height: container.clientHeight };
      const dir = dy > 0 ? -1 : 1;
      ctx.setCanvasZoom(prevZoom => {
        const nextZoom = clamp(prevZoom + dir * REMOTE_CONFIG.wheelZoomStep, 1, MAX_ZOOM);
        if (nextZoom === prevZoom) return prevZoom;
        ctx.setCanvasPan(prev => zoomAtFocal({
          prevZoom, prevPan: prev, focal, nextZoomRaw: nextZoom,
          maxZoom: MAX_ZOOM, containerSize: size, displaySizeAt: ctx.displaySizeAt
        }).pan);
        return nextZoom;
      });
      return;
    }

    // Normal scroll — mirror the touch scroll pipeline: boost + mouseMove once per
    // burst, then only scroll deltas; 150ms gap ends the burst.
    if (!ctx.wheelActiveRef.current) {
      socketEmitFunctions.emitBoostStream?.();
      socketEmitFunctions.emitMouseMove?.(percentX, percentY);
      ctx.wheelActiveRef.current = true;
      ctx.wheelLastBoostRef.current = Date.now();
    } else {
      // Re-boost periodically so long bursts (trackpad inertia) stay smooth
      const now = Date.now();
      if (now - ctx.wheelLastBoostRef.current >= REMOTE_CONFIG.wheelBoostInterval) {
        socketEmitFunctions.emitBoostStream?.();
        ctx.wheelLastBoostRef.current = now;
      }
    }
    if (ctx.wheelEndTimerRef.current) clearTimeout(ctx.wheelEndTimerRef.current);
    ctx.wheelEndTimerRef.current = setTimeout(() => {
      ctx.wheelActiveRef.current = false;
      ctx.wheelAccumRef.current.x = 0;
    }, 150);

    const mult = REMOTE_CONFIG.wheelScrollMultiplier;
    // Native wheel `deltaY > 0 = scroll down`; emitScrollFromDelta treats positive as "up"
    // (matches touch finger-drag-up = page up). Flip sign.
    if (dy) ctx.emitScrollFromDelta(-dy * mult);
    if (dx) {
      const { edgeScrollThreshold, edgeScrollMultiplier } = REMOTE_CONFIG;
      const r = accumulateScrollDelta({
        accum: ctx.wheelAccumRef.current.x, delta: dx * mult,
        threshold: edgeScrollThreshold, multiplier: edgeScrollMultiplier
      });
      ctx.wheelAccumRef.current.x = r.accum;
      if (r.scroll) socketEmitFunctions.emitScroll?.(r.scroll > 0 ? "right" : "left", Math.abs(r.scroll), true);
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

  // Double-click: press+release already produce two native mouse events at the OS level —
  // the remote OS detects the double-click by timing. Emitting here would add a third click.
  if (type === "dblclick") return;

  // ── Selection mode: reuse existing handleSelection logic ────────────────
  if (selectionMode) {
    if (type === "pointerdown") {
      handleSelection?.(event.clientX, event.clientY, "start");
    } else if (type === "pointermove" && ctx.mouseDownButtonRef.current != null) {
      handleSelection?.(event.clientX, event.clientY, "move");
    } else if (type === "pointerup") {
      handleSelection?.(event.clientX, event.clientY, "end");
      ctx.mouseDownButtonRef.current = null;
    }
    if (type === "pointerdown") ctx.mouseDownButtonRef.current = button;
    return;
  }

  // ── Normal drag: press → move (while held) → release ────────────────────
  const { percentX, percentY } = getCanvasCoordinates(event.clientX, event.clientY);

  if (type === "pointerdown") {
    ctx.mouseDownButtonRef.current = button;
    showClickIndicator(event.clientX, event.clientY);
    // press (not click) so dragging works; a release without move is a normal click on any OS
    socketEmitFunctions.emitMousePress?.(percentX, percentY, button);
    return;
  }

  if (type === "pointermove") {
    // Only forward movement while a button is held (drag); plain hover is skipped to avoid flooding
    if (ctx.mouseDownButtonRef.current != null) {
      socketEmitFunctions.emitMouseMove?.(percentX, percentY);
    }
    return;
  }

  if (type === "pointerup") {
    const btn = ctx.mouseDownButtonRef.current || button;
    ctx.mouseDownButtonRef.current = null;
    socketEmitFunctions.emitMouseRelease?.(percentX, percentY, btn);
  }
}
