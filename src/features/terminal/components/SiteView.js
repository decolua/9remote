"use client";

import { useState, useEffect } from "react";

export default function SiteView({ port, siteName, onBack }) {
  const proxyUrl = `${window.location.origin}/proxy/${port}/`;
  const [currentUrl, setCurrentUrl] = useState(`http://localhost:${port}/`);

  useEffect(() => {
    // Listen for navigation messages from iframe
    const handleMessage = (event) => {
      if (event.data?.type === "proxy-navigation" && event.data?.port === port) {
        setCurrentUrl(event.data.url || `http://localhost:${port}${event.data.path || "/"}`);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [port]);

  return (
    <div className="h-[var(--app-height,100vh)] flex flex-col bg-slate-900">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={onBack}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium rounded transition"
        >
          ← Back
        </button>
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="text-green-500 flex-shrink-0">●</span>
          <span className="text-slate-400 text-sm truncate" title={currentUrl}>
            {currentUrl}
          </span>
        </div>
      </div>

      {/* Iframe */}
      <div className="flex-1 min-h-0">
        <iframe
          src={proxyUrl}
          className="w-full h-full border-0"
          title={siteName || `Site on port ${port}`}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-top-navigation"
        />
      </div>
    </div>
  );
}
