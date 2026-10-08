"use client";

// Floating popup window over the parent tab's stream — the desktop rendering
// of a site's window.open() (OAuth flows and friends). It is its own Chrome
// target: its own screencast and its own pixel-perfect input mapping. Mobile
// never mounts this — the pane switches to the popup tab full-screen instead.
import { useCallback, useEffect, useRef } from "react";
import { Globe, Loader2, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useBrowserInvoke } from "@/features/browser/hooks/useBrowserInvoke";
import { useBrowserFrame } from "@/features/browser/hooks/useBrowserFrame";

// Chrome viewport for the popup — larger than the drawn box so the image
// downscales (sharp) instead of upscales (blurry).
const POPUP_VIEWPORT = { width: 720, height: 900 };

export default function BrowserPopupWindow({ busRef, connected = false, targetId, url, profile = "default", onClose }) {
  const { t } = useI18n();
  const invoke = useBrowserInvoke(busRef, profile);
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const hoverTimer = useRef(null);
  const moveTimer = useRef(null);
  const wheelAcc = useRef(null);
  const touchPts = useRef(new Map());

  // Screencast for the popup target — the parent pane's stream keeps running
  // underneath; the host supports one stream per tab.
  useEffect(() => {
    const bus = busRef?.current;
    if (!connected || !bus?.emit || !targetId) return;
    bus.emit("browser:stream.start", {
      targetId,
      ...POPUP_VIEWPORT,
      scale: Math.min(2, window.devicePixelRatio || 1),
      profile
    });
    return () => {
      bus.emit("browser:stream.stop", { targetId });
    };
  }, [busRef, connected, targetId]);

  // Binary frames painted to a canvas by the shared hook (ack after paint).
  const { canvasRef: imgRef, frame, frameRef } = useBrowserFrame({ busRef, connected, targetId });

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (moveTimer.current) clearTimeout(moveTimer.current);
    if (wheelAcc.current?.timer) clearTimeout(wheelAcc.current.timer);
  }, []);

  const sendInput = useCallback((events) => {
    if (!targetId || !events.length) return;
    busRef?.current?.emit?.("browser:input", {
      targetId,
      events,
      profile
    });
  }, [busRef, targetId]);

  // Same pixel-perfect mapping as the pane: the img shrink-fits the stage, its
  // rect IS the drawn frame.
  const pagePoint = useCallback((clientX, clientY) => {
    const el = imgRef.current;
    const meta = frameRef.current?.meta;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    const vW = meta?.deviceWidth || rect.width;
    const vH = meta?.deviceHeight || rect.height;
    const x = Math.round(((clientX - rect.left) / rect.width) * vW);
    const y = Math.round(((clientY - rect.top) / rect.height) * vH);
    return { x: Math.max(0, Math.min(vW, x)), y: Math.max(0, Math.min(vH, y)) };
  }, []);
  const point = useCallback((e) => pagePoint(e.clientX, e.clientY), [pagePoint]);

  const onPointerDown = (e) => {
    if (!frameRef.current || e.button > 2) return;
    vibrate();
    if (e.pointerType === "touch") {
      touchPts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      sendInput([{ t: "touch", type: "start", points: [point(e)] }]);
      return;
    }
    dragRef.current = { sx: e.clientX, sy: e.clientY, moved: false };
    sendInput([{
      t: "pointer", type: "press", x: point(e).x, y: point(e).y,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left"
    }]);
  };

  const onPointerMove = (e) => {
    if (e.pointerType === "touch") {
      if (!touchPts.current.has(e.pointerId)) return;
      touchPts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (moveTimer.current) return;
      const ev = e;
      moveTimer.current = setTimeout(() => {
        moveTimer.current = null;
        sendInput([{ t: "touch", type: "move", points: [point(ev)] }]);
      }, 16);
      return;
    }
    if (dragRef.current && frameRef.current) {
      const d = dragRef.current;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 8) d.moved = true;
      if (d.moved && !moveTimer.current) {
        const ev = e;
        moveTimer.current = setTimeout(() => {
          moveTimer.current = null;
          sendInput([{ t: "pointer", type: "move", x: point(ev).x, y: point(ev).y, drag: true }]);
        }, 30);
      }
      return;
    }
    if (!frameRef.current || hoverTimer.current) return;
    const ev = e;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      sendInput([{ t: "pointer", type: "move", x: point(ev).x, y: point(ev).y }]);
    }, 80);
  };

  const onPointerUp = (e) => {
    if (e.pointerType === "touch") {
      touchPts.current.delete(e.pointerId);
      sendInput([{ t: "touch", type: "end" }]);
      return;
    }
    if (!dragRef.current || !frameRef.current) return;
    dragRef.current = null;
    const p = point(e);
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    sendInput([{ t: "pointer", type: "release", x: p.x, y: p.y, button }]);
  };

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !targetId) return;
    const onWheel = (e) => {
      if (!frameRef.current) return;
      e.preventDefault();
      const p = pagePoint(e.clientX, e.clientY);
      const acc = wheelAcc.current || (wheelAcc.current = { x: p.x, y: p.y, deltaX: 0, deltaY: 0 });
      acc.x = p.x; acc.y = p.y;
      acc.deltaX += e.deltaX;
      acc.deltaY += e.deltaY;
      if (acc.timer) return;
      acc.timer = setTimeout(() => {
        acc.timer = null;
        sendInput([{ t: "wheel", x: acc.x, y: acc.y, deltaX: acc.deltaX, deltaY: acc.deltaY }]);
        acc.deltaX = 0; acc.deltaY = 0;
      }, 50);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [targetId, sendInput, pagePoint]);

  const closePopup = () => {
    vibrate();
    invoke("close", { targetId });
    onClose?.();
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30" onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="w-[min(580px,94%)] h-[min(700px,92%)] rounded-xl overflow-hidden border border-border-subtle bg-white shadow-2xl flex flex-col"
      >
        {/* Title bar — the one bit of window chrome a popup gets */}
        <div className="h-8 shrink-0 flex items-center gap-2 px-3 bg-surface border-b border-border-subtle cursor-default">
          <Globe size={13} className="text-text-muted shrink-0" />
          <span className="flex-1 min-w-0 truncate text-xs text-text-muted">{url || "popup"}</span>
          <button
            onClick={closePopup}
            className="p-1 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
            title={t("common.close")}
          >
            <X size={13} />
          </button>
        </div>
        <div className="flex-1 min-h-0 bg-black relative flex items-center justify-center touch-none select-none outline-none">
          {/* Always mounted — paint() runs before the first frame state. */}
          <canvas
            ref={imgRef}
            width={frame?.w || 16}
            height={frame?.h || 16}
            className={`max-w-full max-h-full object-contain pointer-events-none ${frame ? "" : "opacity-0"}`}
          />
          {!frame && (
            <div className="absolute inset-0 flex items-center justify-center text-text-muted text-xs gap-2 bg-surface">
              <Loader2 size={14} className="animate-spin" /> {t("sites.browserPaneLoading")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
