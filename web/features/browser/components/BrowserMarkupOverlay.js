"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, RotateCw, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

export default function BrowserMarkupOverlay({ frameImgSrc, onClose }) {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [color, setColor] = useState("#ef4444");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.src = frameImgSrc;
    img.onload = () => {
      canvas.width = img.naturalWidth || 800;
      canvas.height = img.naturalHeight || 600;
      ctx.drawImage(img, 0, 0);
    };
  }, [frameImgSrc]);

  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };

  const startDraw = (e) => {
    setIsDrawing(true);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const pos = getPos(e);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  };

  const draw = (e) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  };

  const stopDraw = () => {
    setIsDrawing(false);
  };

  const resetCanvas = () => {
    vibrate();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.src = frameImgSrc;
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
  };

  const copyComposite = async () => {
    vibrate();
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } catch { /* clipboard permission */ }
  };

  return (
    <div className="absolute inset-0 z-40 bg-black/80 flex flex-col items-center justify-between p-3 select-none">
      <div className="w-full flex items-center justify-between bg-surface/90 backdrop-blur px-3 py-2 rounded-brand border border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text">Markup</span>
          {["#ef4444", "#f59e0b", "#10b981", "#3b82f6"].map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-5 h-5 rounded-full border-2 transition-transform ${color === c ? "scale-110 border-white" : "border-transparent"}`}
              style={{ backgroundColor: c }}
            />
          ))}
          <button
            onClick={resetCanvas}
            className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand text-xs flex items-center gap-1"
            title="Reset"
          >
            <RotateCw size={13} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={copyComposite}
            className="px-2.5 py-1 bg-brand-500 hover:bg-brand-600 text-white rounded-brand text-xs font-medium flex items-center gap-1.5"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy Image"}
          </button>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text rounded-brand"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 w-full flex items-center justify-center p-2 overflow-hidden">
        <canvas
          ref={canvasRef}
          onPointerDown={startDraw}
          onPointerMove={draw}
          onPointerUp={stopDraw}
          onPointerCancel={stopDraw}
          className="max-w-full max-h-full object-contain cursor-crosshair rounded border border-border-subtle shadow-2xl touch-none"
        />
      </div>
    </div>
  );
}
