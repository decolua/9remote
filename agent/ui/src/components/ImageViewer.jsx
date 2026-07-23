import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import Icon from "./Icon";
import { isImageFile } from "../lib/fileExplorer/constants";

export { isImageFile };

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

export default function ImageViewer({ filePath, fileSocket }) {
  const [dataUrl, setDataUrl] = useState("");
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const containerRef = useRef(null);
  const imgRef = useRef(null);
  const pinchRef = useRef(null);
  const panRef = useRef(null);
  const lastTapRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDataUrl("");
    setMeta(null);
    setScale(1);
    setPos({ x: 0, y: 0 });
    fileSocket.readMedia(filePath).then((r) => {
      if (cancelled) return;
      if (r.success) {
        setDataUrl(r.dataUrl);
        setMeta({
          size: r.originalSize || r.size,
          width: r.width,
          height: r.height,
          scaled: r.scaled,
          originalWidth: r.originalWidth,
          originalHeight: r.originalHeight
        });
      } else setError(r.error || "Failed to load image");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [filePath, fileSocket]);

  // Clamp pan so the image can't be dragged off-screen
  const clampPos = useCallback((x, y, s) => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return { x, y };
    const cw = container.clientWidth, ch = container.clientHeight;
    const iw = img.clientWidth * s, ih = img.clientHeight * s;
    const maxX = Math.max(0, (iw - cw) / 2);
    const maxY = Math.max(0, (ih - ch) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((factor, originX, originY) => {
    setScale((prevScale) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prevScale * factor));
      if (next === prevScale) return prevScale;
      if (originX != null && originY != null) {
        const container = containerRef.current;
        if (container) {
          const cx = container.clientWidth / 2;
          const cy = container.clientHeight / 2;
          const dx = originX - cx;
          const dy = originY - cy;
          setPos((prevPos) => clampPos(
            (prevPos.x - dx) * (next / prevScale) + dx,
            (prevPos.y - dy) * (next / prevScale) + dy,
            next
          ));
        }
      } else {
        setPos((prevPos) => clampPos(prevPos.x, prevPos.y, next));
      }
      return next;
    });
  }, [clampPos]);

  // --- Touch gestures ---
  const distance = (t1, t2) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

  const onTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      panRef.current = null;
      pinchRef.current = { dist: distance(e.touches[0], e.touches[1]), scale, pos };
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        if (scale > 1.01) reset();
        else { setScale(2); setPos({ x: 0, y: 0 }); }
        lastTapRef.current = 0;
        panRef.current = null;
        return;
      }
      lastTapRef.current = now;
      if (scale > 1.01) {
        panRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, pos };
      }
    }
  }, [scale, pos, reset]);

  const onTouchMove = useCallback((e) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const d = distance(e.touches[0], e.touches[1]);
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchRef.current.scale * (d / pinchRef.current.dist)));
      setScale(next);
      setPos((p) => clampPos(p.x, p.y, next));
    } else if (e.touches.length === 1 && panRef.current) {
      e.preventDefault();
      const t = e.touches[0];
      const dx = t.clientX - panRef.current.x;
      const dy = t.clientY - panRef.current.y;
      setPos(clampPos(panRef.current.pos.x + dx, panRef.current.pos.y + dy, scale));
    }
  }, [scale, clampPos]);

  const onTouchEnd = useCallback((e) => {
    if (e.touches.length < 2) pinchRef.current = null;
    if (e.touches.length === 0) panRef.current = null;
  }, []);

  // --- Wheel zoom (desktop) ---
  const onWheel = useCallback((e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = containerRef.current?.getBoundingClientRect();
    zoomBy(factor, rect ? e.clientX - rect.left : null, rect ? e.clientY - rect.top : null);
  }, [zoomBy]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted gap-2">
        <Icon name="loader2" size={20} className="animate-spin" />
        <span>Loading image...</span>
      </div>
    );
  }
  if (error) {
    return <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>;
  }

  const dims = meta?.width && meta?.height ? `${meta.width}×${meta.height}` : "";
  const scaledDown = meta?.scaled && meta?.originalWidth && meta?.originalWidth !== meta?.width;

  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="bg-surface border-b border-border px-3 py-1.5 flex items-center gap-2 text-xs text-text-muted">
        <span className="truncate flex-1">{filePath.split("/").pop()}</span>
        {meta?.size ? <span className="text-text-subtle">{formatSize(meta.size)}</span> : null}
        {dims ? <span className="text-text-subtle">{dims}{scaledDown ? " ↓" : ""}</span> : null}
        <button onClick={() => zoomBy(1 / 1.2)} className="px-2 hover:bg-surface-2 rounded">−</button>
        <span className="w-12 text-center">{Math.round(scale * 100)}%</span>
        <button onClick={() => zoomBy(1.2)} className="px-2 hover:bg-surface-2 rounded">+</button>
        <button onClick={reset} className="px-2 hover:bg-surface-2 rounded">Reset</button>
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden flex items-center justify-center bg-[repeating-conic-gradient(#0001_0%_25%,transparent_0%_50%)] bg-[length:20px_20px] touch-none"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onWheel={onWheel}
      >
        <img
          ref={imgRef}
          src={dataUrl}
          alt={filePath}
          draggable={false}
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`, transformOrigin: "center", willChange: "transform" }}
          className="max-w-full max-h-full object-contain select-none"
        />
      </div>
    </div>
  );
}
