"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "@/shared/components/ui/Icon";

// Ponytail: PDF embedded via iframe data URL. Large PDFs inflate the socket
// payload; add a PDF.js range loader if users hit the 50MB cap often.
export default function PdfViewer({ filePath, fileSocket }) {
  const [dataUrl, setDataUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDataUrl("");
    fileSocket.readMedia(filePath).then(r => {
      if (cancelled) return;
      if (r.success) setDataUrl(r.dataUrl);
      else setError(r.error || "Failed to load PDF");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [filePath, fileSocket]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted gap-2">
        <Loader2 className="animate-spin" size={20} />
        <span>Loading PDF...</span>
      </div>
    );
  }
  if (error) {
    return <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>;
  }

  return (
    <iframe src={dataUrl} title="PDF preview" className="h-full w-full bg-bg" />
  );
}
