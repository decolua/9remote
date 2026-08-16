"use client";

import { useState, useRef, useEffect } from "react";
import { vibrate } from "@/shared/utils/vibration";

const LONG_PRESS_MS = 180;
const MOVE_CANCEL_PX = 8;   // finger drift that means "scrolling", not "holding"
const DRAG_START_PX = 3;    // movement before the card starts following the pointer

// Pointer-based drag reorder (mobile-first). Long-press activates drag; the card
// follows the pointer via direct DOM writes (no re-render per move).
// Extracted verbatim from SessionList.
export function useSessionDragReorder({ connected, onReorderSession }) {
  const [drag, setDrag] = useState(null); // { workspaceId, fromIdx, overIdx }
  const dragRef = useRef(null);
  const pressTimer = useRef(null);
  const pressStartRef = useRef(null);
  const suppressClickRef = useRef(false);

  const clearPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };

  const resetCard = (el) => {
    if (!el) return;
    el.style.transform = "";
    el.style.zIndex = "";
    el.style.transition = "";
    el.style.willChange = "";
  };

  const startDrag = (e, workspaceId, ids, fromIdx, cardEl) => {
    vibrate();
    dragRef.current = { workspaceId, ids, fromIdx, overIdx: fromIdx, startX: e.clientX, startY: e.clientY, cardEl, moved: false };
    setDrag({ workspaceId, fromIdx, overIdx: fromIdx });
    try { cardEl.setPointerCapture(e.pointerId); } catch {}
  };

  const onGripPointerDown = (e, workspaceId, ids, fromIdx) => {
    if (!connected || ids.length < 2) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    clearPress();
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    const cardEl = e.currentTarget;
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      startDrag(e, workspaceId, ids, fromIdx, cardEl);
    }, LONG_PRESS_MS);
  };

  // Cancel pending long-press if the finger moves (likely scrolling) during hold
  const onCardPointerMove = (e) => {
    if (!pressTimer.current || !pressStartRef.current) return;
    if (Math.abs(e.clientX - pressStartRef.current.x) > MOVE_CANCEL_PX ||
        Math.abs(e.clientY - pressStartRef.current.y) > MOVE_CANCEL_PX) clearPress();
  };

  useEffect(() => {
    if (!drag) return;
    const findIdx = (x, y) => {
      const el = document.elementFromPoint(x, y)?.closest("[data-session-card]");
      if (!el) return null;
      const i = Number(el.getAttribute("data-card-idx"));
      return Number.isNaN(i) ? null : i;
    };
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault(); // block touch scroll during active drag
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) > DRAG_START_PX) d.moved = true;
      if (d.moved) {
        // Drive the card straight to the DOM (60fps, no React re-render per move)
        d.cardEl.style.transition = "none";
        d.cardEl.style.willChange = "transform";
        d.cardEl.style.zIndex = "50";
        d.cardEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.05) rotate(2deg)`;
      }
      const i = findIdx(e.clientX, e.clientY);
      if (i != null && i !== d.overIdx) {
        d.overIdx = i;
        setDrag({ ...drag, overIdx: i });
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d) {
        // Drag was activated (long-press timer fired) → swallow the synthesized click that follows,
        // even if the finger barely moved. Without this, a long-press-and-release (no reorder)
        // still opens the terminal.
        suppressClickRef.current = true;
        resetCard(d.cardEl);
        if (d.fromIdx !== d.overIdx) {
          const ids = [...d.ids];
          const [moved] = ids.splice(d.fromIdx, 1);
          ids.splice(d.overIdx, 0, moved);
          onReorderSession?.(ids);
          vibrate();
        }
      }
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, onReorderSession]);

  return { drag, suppressClickRef, clearPress, onGripPointerDown, onCardPointerMove };
}
