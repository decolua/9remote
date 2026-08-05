"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "@/shared/components/ui/Icon";

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Media preview. Audio/video stream progressively over the FILE channel via
// MediaSource Extensions (play starts before the full file arrives); images and
// MSE-incompatible types fall back to the base64 readMedia path.
export default function MediaViewer({ filePath, fileSocket }) {
  const [src, setSrc] = useState("");
  const [mime, setMime] = useState("");
  const [size, setSize] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let cancel = null;
    let ms = null, url = null, sb = null;
    const queue = [];
    let done = false;

    setLoading(true);
    setError("");
    setSrc("");
    setMime("");
    setSize(0);

    const flush = () => {
      if (cancelled || !sb || sb.updating) return;
      if (queue.length) { sb.appendBuffer(queue.shift()); return; }
      if (done && ms && ms.readyState === "open") { try { ms.endOfStream(); } catch {} }
    };

    cancel = fileSocket.streamMedia(filePath, {
      onMeta: ({ mime: m, size: s }) => {
        if (cancelled) return;
        setMime(m);
        setSize(s);
        const canMSE = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(m);
        if (!canMSE) {
          // wav/flac/ogg on Safari etc. — fall back to base64 (bounded by readMedia cap).
          cancel?.();
          fileSocket.readMedia(filePath).then(r => {
            if (cancelled) return;
            if (r.success) { setSrc(r.dataUrl); setMime(r.mime || m); setSize(r.originalSize || r.size || s); }
            else setError(r.error || "Failed to load media");
            setLoading(false);
          });
          return;
        }
        ms = new MediaSource();
        url = URL.createObjectURL(ms);
        setSrc(url);
        setLoading(false);
        ms.addEventListener("sourceopen", () => {
          if (cancelled) return;
          sb = ms.addSourceBuffer(m);
          sb.addEventListener("updateend", flush);
          flush();
        });
      },
      onChunk: (payload) => { if (!cancelled) { queue.push(payload); flush(); } },
      onDone: () => { if (!cancelled) { done = true; flush(); } },
      onError: (e) => { if (!cancelled) { setError(e.message || "Stream error"); setLoading(false); } }
    });

    return () => {
      cancelled = true;
      cancel?.();
      if (url) URL.revokeObjectURL(url);
      try { if (ms && ms.readyState === "open") ms.endOfStream(); } catch {}
    };
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
      <div className="bg-surface border-b border-border px-3 py-1.5 flex items-center gap-2 text-xs text-text-muted">
        <span className="truncate flex-1">{name}</span>
        {size ? <span className="text-text-subtle">{formatSize(size)}</span> : null}
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-black/30">
        {isVideo ? (
          <video src={src} controls className="max-h-full max-w-full" />
        ) : (
          <audio src={src} controls className="w-full max-w-md" />
        )}
      </div>
    </div>
  );
}
