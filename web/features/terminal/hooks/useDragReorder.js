import { useCallback, useRef, useState } from "react";
import { vibrate } from "@/shared/utils/vibration";

// Pointer drag-to-reorder shared by the sidebar list and the tab strip. Rows/tabs move by
// transform only while dragging — the order is committed once on release, so no re-render
// (and no round-trip) fires per pointermove. Sizes are measured at drag start, so tabs of
// unequal width reorder as correctly as fixed-height rows.
const AXIS = {
  y: { pos: "clientY", start: "top", size: "height" },
  x: { pos: "clientX", start: "left", size: "width" }
};

export function useDragReorder({ axis = "y", threshold = 3, onCommit }) {
  const [dragId, setDragId] = useState(null);
  const elsRef = useRef(new Map()); // item id -> element
  const movedRef = useRef(false);
  const clearMovedRef = useRef(null);
  const captureRef = useRef(null); // { el, pointerId } held for the current drag
  const finishRef = useRef(null); // teardown of the current drag, null when idle

  const registerEl = useCallback((id) => (el) => {
    if (el) elsRef.current.set(id, el);
    else elsRef.current.delete(id);
  }, []);

  // True once per drag that actually moved — lets a click handler ignore the release.
  // A drag that ends over another element fires no click at all, so the flag also
  // self-clears; otherwise it would swallow the NEXT genuine click.
  const consumeClick = useCallback(() => {
    const moved = movedRef.current;
    movedRef.current = false;
    if (clearMovedRef.current) { clearTimeout(clearMovedRef.current); clearMovedRef.current = null; }
    return moved;
  }, []);

  const startDrag = useCallback((e, id, ids) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // WebKit drops the pointerup of a release captured on another element, which would
    // otherwise leave the previous drag active — and its swallow-next-click flag set, so
    // the next tab click needs a second press. That drag never ended, so drop it without
    // committing. The flag resets here too: a click always fires right after its own
    // pointerup, never after a later press, so by this point any pending swallow is stale.
    finishRef.current?.(false);
    movedRef.current = false;
    if (clearMovedRef.current) { clearTimeout(clearMovedRef.current); clearMovedRef.current = null; }
    if (!ids || ids.length < 2) return;
    const fromIdx = ids.indexOf(id);
    if (fromIdx < 0) return;

    const a = AXIS[axis];
    const boxes = ids.map((itemId) => {
      const rect = elsRef.current.get(itemId)?.getBoundingClientRect();
      return rect ? { start: rect[a.start], size: rect[a.size] } : null;
    });
    if (boxes.some((b) => !b)) return;

    movedRef.current = false;
    if (clearMovedRef.current) { clearTimeout(clearMovedRef.current); clearMovedRef.current = null; }

    const self = boxes[fromIdx];
    const startPos = e[a.pos];
    const captureTarget = e.currentTarget;
    const pointerId = e.pointerId;
    let toIdx = fromIdx;
    let frame = null;

    const paint = (delta) => {
      frame = null;
      const dragged = elsRef.current.get(id);
      if (dragged) dragged.style.transform = `translate${axis.toUpperCase()}(${delta}px)`;
      // Every passed item slides one dragged-size slot to open the gap it will land in
      ids.forEach((itemId, i) => {
        if (itemId === id) return;
        const el = elsRef.current.get(itemId);
        if (!el) return;
        let shift = 0;
        if (fromIdx < toIdx && i > fromIdx && i <= toIdx) shift = -self.size;
        else if (fromIdx > toIdx && i >= toIdx && i < fromIdx) shift = self.size;
        el.style.transform = shift ? `translate${axis.toUpperCase()}(${shift}px)` : "";
      });
    };

    const onMove = (ev) => {
      if (ev.pointerType === "mouse" && ev.buttons === 0) {
        onUp();
        return;
      }
      const delta = ev[a.pos] - startPos;
      if (!movedRef.current) {
        if (Math.abs(delta) < threshold) return;
        movedRef.current = true;
        vibrate();
        setDragId(id);
        // Captured only once the drag is real: WebKit drops the pointerdown that
        // follows ANY captured press, so a plain click must never capture — it would
        // cost the user the next click. A genuine drag already eats its own release.
        try { captureTarget.setPointerCapture?.(pointerId); } catch {}
        captureRef.current = { el: captureTarget, pointerId };
      }
      // Slot the dragged item's centre now sits over — the last box it has reached
      const centre = self.start + self.size / 2 + delta;
      let next = 0;
      for (let i = 0; i < boxes.length; i++) if (centre >= boxes[i].start) next = i;
      toIdx = next;
      if (frame) return;
      frame = requestAnimationFrame(() => paint(delta));
    };

    // Tears the drag down. `commit` is false when the release was never seen (a newer
    // drag superseding this one), so a half-finished drag never reorders the list.
    const finish = (commit) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      finishRef.current = null;
      const capture = captureRef.current;
      captureRef.current = null;
      try { capture?.el.releasePointerCapture?.(capture.pointerId); } catch {}
      if (frame) { cancelAnimationFrame(frame); frame = null; }
      for (const el of elsRef.current.values()) if (el) el.style.transform = "";
      setDragId(null);
      if (!commit || !movedRef.current) return;
      // The click (if any) lands synchronously right after this — a timeout out-lives it.
      clearMovedRef.current = setTimeout(() => { clearMovedRef.current = null; movedRef.current = false; }, 0);
      if (toIdx === fromIdx) return;
      const next = [...ids];
      next.splice(toIdx, 0, next.splice(fromIdx, 1)[0]);
      vibrate();
      onCommit?.(next);
    };

    const onUp = () => finish(true);
    finishRef.current = finish;

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  }, [axis, threshold, onCommit]);

  return { dragId, registerEl, startDrag, consumeClick };
}

export default useDragReorder;
