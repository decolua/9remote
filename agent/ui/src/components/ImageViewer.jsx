import { useState, useEffect } from "preact/hooks";
import Icon from "./Icon";
import { isImageFile } from "../lib/fileExplorer/constants";

export { isImageFile };

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function ImageViewer({ filePath, fileSocket }) {
  const [dataUrl, setDataUrl] = useState("");
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDataUrl("");
    setMeta(null);
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
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-[repeating-conic-gradient(#0001_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
        <img
          src={dataUrl}
          alt={filePath}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    </div>
  );
}
