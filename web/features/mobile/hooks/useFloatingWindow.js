"use client";

// Drag + resize for the floating mirror. Pointer events only (works with mouse,
// pen and touch), and the box is kept partly on screen so it can never be lost
// behind an edge.

import { useCallback, useEffect, useRef, useState } from "react";
import { MOBILE_FLOAT } from "@/features/terminal/constants/terminalConfig";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Default box: bottom-right, respecting the viewport it has to fit in. */
function defaultRect() {
  const w = MOBILE_FLOAT.width.default;
  const h = Math.min(MOBILE_FLOAT.height.default, window.innerHeight - MOBILE_FLOAT.defaultOffset * 2);
  return {
    x: Math.max(MOBILE_FLOAT.margin, window.innerWidth - w - MOBILE_FLOAT.defaultOffset),
    y: Math.max(MOBILE_FLOAT.margin, window.innerHeight - h - MOBILE_FLOAT.defaultOffset),
    w,
    h
  };
}

// A window narrower than the viewport must still be reachable: keep a margin of
// it visible rather than clamping the whole box inside, which would fight the
// user on a small screen.
function keepOnScreen(rect) {
  const maxX = window.innerWidth - MOBILE_FLOAT.margin * 4;
  const maxY = window.innerHeight - MOBILE_FLOAT.margin * 3;
  return {
    ...rect,
    x: clamp(rect.x, MOBILE_FLOAT.margin - rect.w + MOBILE_FLOAT.margin * 4, maxX),
    y: clamp(rect.y, MOBILE_FLOAT.margin, maxY)
  };
}

export function useFloatingWindow({ rect, onChange, enabled }) {
  // Lazy initial state instead of an effect: the box has a correct position on
  // its first paint, so it never flashes at the wrong place.
  const [live, setLive] = useState(() =>
    typeof window === "undefined" ? null : (rect ? keepOnScreen(rect) : defaultRect())
  );
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);
  // Mirrors `live` so the pointer handlers can read the current rect without
  // going through a state updater.
  const liveRef = useRef(live);

  // Cheaper and more predictable than an effect: every write to `live` goes
  // through here, so the ref can never lag behind it.
  const applyRect = useCallback((rect) => {
    liveRef.current = rect;
    setLive(rect);
  }, []);

  // A resized viewport can leave the box off screen (or taller than the window).
  useEffect(() => {
    if (!enabled) return;
    const onResize = () => {
      const prev = liveRef.current;
      if (!prev) return;
      const h = Math.min(prev.h, window.innerHeight - MOBILE_FLOAT.margin * 2);
      applyRect(keepOnScreen({ ...prev, h }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled, applyRect]);

  const begin = useCallback((event, mode) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: live
    };
    setDragging(true);
  }, [live]);

  const move = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (drag.mode === "move") {
      applyRect(keepOnScreen({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }));
      return;
    }
    // Resize. `mode` names the edges being dragged ("nw", "se", "e", …): a west
    // or north edge moves the opposite corner, so x/y track the size change to
    // keep the anchored edge still.
    const { origin, mode } = drag;
    const west = mode.includes("w");
    const north = mode.includes("n");
    const horizontal = west || mode.includes("e");
    const vertical = north || mode.includes("s");
    const maxH = window.innerHeight - MOBILE_FLOAT.margin * 2;

    // A north or west drag also moves the box, so the size is bounded by how
    // far the anchored edge can travel: without this the title bar — the only
    // way to move the window — could be pushed off the top of the screen.
    const maxNorthH = north ? origin.y + origin.h - MOBILE_FLOAT.margin : maxH;
    const maxWestW = west ? origin.x + origin.w - MOBILE_FLOAT.margin : MOBILE_FLOAT.width.max;

    const w = horizontal
      ? clamp(west ? origin.w - dx : origin.w + dx, MOBILE_FLOAT.width.min, Math.min(MOBILE_FLOAT.width.max, maxWestW))
      : origin.w;
    const h = vertical
      ? clamp(north ? origin.h - dy : origin.h + dy, MOBILE_FLOAT.height.min, Math.min(maxH, maxNorthH))
      : origin.h;

    applyRect({
      x: west ? origin.x + (origin.w - w) : origin.x,
      y: north ? origin.y + (origin.h - h) : origin.y,
      w,
      h
    });
  }, [applyRect]);

  const end = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    // Persist only on release: storing every frame would thrash sessionStorage.
    // Read the rect from a ref rather than from inside a setLive updater —
    // React runs updaters during render, so a store write in there lands
    // mid-render of another component.
    if (liveRef.current) onChange?.(liveRef.current);
  }, [onChange]);

  return {
    rect: live,
    dragging,
    onDragHandlePointerDown: (e) => begin(e, "move"),
    // Edges are named by compass point; pass the one being grabbed.
    onResizeHandlePointerDown: (edge) => (e) => begin(e, edge),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end
  };
}
