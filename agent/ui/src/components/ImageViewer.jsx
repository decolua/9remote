import { useState, useEffect } from "preact/hooks";
import Icon from "./Icon";
import { isImageFile } from "../lib/fileExplorer/constants";

export { isImageFile };

export default function ImageViewer({ filePath, fileSocket }) {
  const [dataUrl, setDataUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDataUrl("");
    setZoom(1);
    fileSocket.readMedia(filePath).then((r) => {
      if (cancelled) return;
      if (r.success) setDataUrl(r.dataUrl);
      else setError(r.error || "Failed to load image");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [filePath, fileSocket]);

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

  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="bg-surface border-b border-border px-3 py-1.5 flex items-center gap-2 text-xs text-text-muted">
        <span className="truncate flex-1">{filePath.split("/").pop()}</span>
        <button onClick={() => setZoom((z) => Math.max(0.1, z - 0.1))} className="px-2 hover:bg-surface-2 rounded">−</button>
        <span className="w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(8, z + 0.1))} className="px-2 hover:bg-surface-2 rounded">+</button>
        <button onClick={() => setZoom(1)} className="px-2 hover:bg-surface-2 rounded">Reset</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-[repeating-conic-gradient(#0001_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
        <img
          src={dataUrl}
          alt={filePath}
          style={{ transform: `scale(${zoom})`, transformOrigin: "center", imageRendering: "pixelated" }}
          className="max-w-none transition-transform"
        />
      </div>
    </div>
  );
}
