"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight, Loader2 } from "@/shared/components/ui/Icon";

// How far a finger has to travel before it is a swipe rather than a tap, and how much of
// the width it must cover. Coarse on purpose: a pinch or a scroll must never flip the page.
const SWIPE_MIN_PX = 60;
const SWIPE_RATIO = 0.18;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

/**
 * Full-screen picture viewer.
 *
 * One surface for every way of looking at an image: pinch or wheel to zoom, drag to pan
 * while zoomed, swipe to move between the turn's pictures, Escape or a tap outside to
 * close. It renders through a portal so the pane's own scroll and transforms cannot clip
 * it, and it owns the keyboard while open — the composer underneath must not see Escape.
 */
export const ImageLightbox = memo(function ImageLightbox({ images = [], index = 0, onClose, fileBus = null }) {
  const [at, setAt] = useState(index);
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const gestureRef = useRef(null);
  const frameRef = useRef(null);
  const panelRef = useRef(null);
  const imgRef = useRef(null);

  const current = images[at] || null;

  // One picture at a time, read on demand — a turn can hold twenty and none of the other
  // nineteen should cost a byte until it is looked at.
  useEffect(() => {
    setSrc(null);
    setFailed(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    if (!current?.path || !fileBus?.readMedia) return;
    let live = true;
    fileBus.readMedia(current.path).then((res) => {
      if (!live) return;
      if (res?.success && res.dataUrl) setSrc(res.dataUrl);
      else setFailed(true);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [current?.path, fileBus]);

  const step = useCallback((delta) => {
    setAt((i) => {
      const next = i + delta;
      return next < 0 || next >= images.length ? i : next;
    });
  }, [images.length]);

  // How far the picture may slide: exactly the overhang the scale creates. Beyond that it
  // would be dragged off the panel and there would be nothing left to grab.
  const clampPan = useCallback((next, z) => {
    const el = imgRef.current;
    if (!el || z <= ZOOM_MIN) return { x: 0, y: 0 };
    const mx = (el.clientWidth * (z - 1)) / 2;
    const my = (el.clientHeight * (z - 1)) / 2;
    return {
      x: Math.max(-mx, Math.min(mx, next.x)),
      y: Math.max(-my, Math.min(my, next.y))
    };
  }, []);

  // At 1× the picture is centred again — an offset left over from a previous zoom
  // would otherwise show it pushed to one corner with nothing to drag it back.
  const applyZoom = useCallback((next) => {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    setZoom(z);
    if (z === ZOOM_MIN) setPan({ x: 0, y: 0 });
    else setPan((p) => clampPan(p, z));
  }, [clampPan]);

  // Keyboard: arrows move, Escape closes. Captured here because the composer keeps focus
  // on the pane underneath and would otherwise act on the same keys.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose?.(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "0") { setZoom(1); setPan({ x: 0, y: 0 }); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, step]);

  // A wheel zooms about the centre; without it a desktop reader had no way in.
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    applyZoom(zoom - e.deltaY * 0.002);
  };

  const onPointerDown = (e) => {
    const g = gestureRef.current;
    // A second finger JOINS the gesture — rebuilding the object here threw the first
    // finger away, so `pointers.size` could never reach 2 and pinch never fired.
    if (g) {
      g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Pinch starts from wherever the fingers already are; the baseline is taken on
      // the first move that sees both.
      g.pinch0 = null;
      g.swiped = true;
      return;
    }
    gestureRef.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      movedX: 0,
      zoom0: zoom,
      pan0: pan,
      pinch0: null,
      // Whether the press STARTED on the backdrop. Checked here, not on pointerup: pointer
      // capture retargets the release to the frame, so asking then says "backdrop" for a
      // press that began on a button — which is how every press closed the viewer.
      startedOnBackdrop: e.target === frameRef.current,
      pointers: new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]])
    };
    // No pointer capture: the buttons must keep their own presses, and a gesture that
    // leaves the frame is harmless here — the backdrop covers the whole viewport.
  };

  const onPointerMove = (e) => {
    const g = gestureRef.current;
    if (!g) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Two fingers: pinch, and never treat the same gesture as a swipe.
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (!g.pinch0) { g.pinch0 = dist; g.zoom0 = zoom; return; }
      applyZoom(g.zoom0 * (dist / g.pinch0));
      g.swiped = true;
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (zoom > 1) {
      setPan(clampPan({ x: g.pan0.x + dx, y: g.pan0.y + dy }, zoom));
      g.swiped = true;
      return;
    }
    g.movedX = dx;
    if (Math.abs(dx) > 8) g.swiped = true;
    setPan({ x: dx, y: 0 });
  };

  const onPointerUp = (e) => {
    const g = gestureRef.current;
    if (!g) return;
    // Lifting one finger of a pinch leaves the other down: drop just that pointer and
    // keep the gesture, otherwise the remaining finger restarts as a fresh pan.
    if (g.pointers.size > 1) {
      g.pointers.delete(e.pointerId);
      g.pinch0 = null;
      return;
    }
    g.pointers.delete(e.pointerId);
    if (g.pointers.size > 0) return;
    gestureRef.current = null;
    const dx = g.movedX || 0;
    const width = frameRef.current?.clientWidth || window.innerWidth;
    if (zoom === 1 && Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > width * SWIPE_RATIO) {
      step(dx < 0 ? 1 : -1);
    }
    // Keep the offset while zoomed — resetting on release snapped the picture back to
    // centre, so a pan never stuck and a zoomed image could not be read edge to edge.
    if (zoom === 1) setPan({ x: 0, y: 0 });
    // Only a tap that started AND stayed on the backdrop closes.
    if (!g.swiped && g.startedOnBackdrop) onClose?.();
  };

  if (typeof document === "undefined" || !current) return null;

  return createPortal(
    <div
      ref={frameRef}
      className="scrim-lightbox fixed inset-0 z-[9999] flex items-center justify-center select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onClick={(e) => { if (e.target === frameRef.current) onClose?.(); }}
    >
      {/* A dialog, not a takeover: the picture gets a bounded panel with its own
          chrome, the way every other modal in the app does. Full-bleed put the image
          edge to edge with no frame to read it against, which is what made it hard
          to look at. */}
      <div
        ref={panelRef}
        className="lightbox-panel relative z-10 flex max-h-[min(88vh,calc(var(--app-height,100vh)-2rem))] w-[min(94vw,1100px)] flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-center gap-2 px-2.5 py-2">
          <span className="min-w-0 truncate font-mono text-[11.5px] text-white/75">{current.name}</span>
          {images.length > 1 && (
            <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10.5px] text-white/60 tabular-nums">
              {at + 1} / {images.length}
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full p-1.5 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => step(-1)}
                disabled={at === 0}
                className="lightbox-arrow absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full p-2 text-white/70 transition-colors hover:text-white disabled:opacity-20"
                title="Previous"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                disabled={at === images.length - 1}
                className="lightbox-arrow absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full p-2 text-white/70 transition-colors hover:text-white disabled:opacity-20"
                title="Next"
              >
                <ChevronRight size={18} />
              </button>
            </>
          )}

          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              src={src}
              alt={current.name}
              draggable={false}
              className="lightbox-image mx-auto block max-h-full max-w-full object-contain"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transition: gestureRef.current ? "none" : "transform 160ms ease-out",
                touchAction: "none"
              }}
            />
          ) : failed ? (
            <span className="flex h-full items-center justify-center font-mono text-xs text-white/55">
              This image is no longer on the host.
            </span>
          ) : (
            <span className="flex h-full items-center justify-center">
              <Loader2 size={22} className="animate-spin text-white/60" />
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
});

export default ImageLightbox;
