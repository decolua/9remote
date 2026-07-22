import { useState, useEffect } from "preact/hooks";
import Icon from "./Icon";

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Ponytail: video/audio load as base64 data URLs. Fine for typical clips;
// multi-hundred-MB files will be slow and may hit socket limits.
export default function MediaViewer({ filePath, fileSocket }) {
  const [dataUrl, setDataUrl] = useState("");
  const [mime, setMime] = useState("");
  const [size, setSize] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDataUrl("");
    setMime("");
    setSize(0);
    fileSocket.readMedia(filePath).then((r) => {
      if (cancelled) return;
      if (r.success) { setDataUrl(r.dataUrl); setMime(r.mime || ""); setSize(r.originalSize || r.size || 0); }
      else setError(r.error || "Failed to load media");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [filePath, fileSocket]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted gap-2">
        <Icon name="loader2" size={20} className="animate-spin" />
        <span>Loading media...</span>
      </div>
    );
  }
  if (error) {
    return <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>;
  }

  const isVideo = mime.startsWith("video/");
  const name = filePath.split("/").pop();

  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="bg-surface border-b border-border px-3 py-1.5 flex items-center gap-2 text-xs text-text-muted">
        <span className="truncate flex-1">{name}</span>
        {size ? <span className="text-text-subtle">{formatSize(size)}</span> : null}
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-black/30">
        {isVideo ? (
          <video src={dataUrl} controls className="max-h-full max-w-full" />
        ) : (
          <audio src={dataUrl} controls className="w-full max-w-md" />
        )}
      </div>
    </div>
  );
}
