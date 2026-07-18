"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "@/shared/components/ui/Icon";

// Ponytail: video/audio load as base64 data URLs. Fine for typical clips;
// multi-hundred-MB files will be slow and may hit socket limits — at that point
// switch to HTTP range serving.
export default function MediaViewer({ filePath, fileSocket }) {
  const [dataUrl, setDataUrl] = useState("");
  const [mime, setMime] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDataUrl("");
    setMime("");
    fileSocket.readMedia(filePath).then(r => {
      if (cancelled) return;
      if (r.success) { setDataUrl(r.dataUrl); setMime(r.mime || ""); }
      else setError(r.error || "Failed to load media");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [filePath, fileSocket]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted gap-2">
        <Loader2 className="animate-spin" size={20} />
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
      <div className="bg-surface border-b border-border px-3 py-1.5 flex items-center text-xs text-text-muted">
        <span className="truncate flex-1">{name}</span>
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
