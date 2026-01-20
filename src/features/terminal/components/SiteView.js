"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export default function SiteView({ port, siteName, onBack }) {
  const proxyUrl = `${window.location.origin}/proxy/${port}/`;
  const iframeRef = useRef(null);
  
  // History tracking
  const [history, setHistory] = useState([`http://localhost:${port}/`]);
  const [historyIndex, setHistoryIndex] = useState(0);
  
  const currentUrl = history[historyIndex] || `http://localhost:${port}/`;
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  useEffect(() => {
    // Listen for navigation messages from iframe
    const handleMessage = (event) => {
      if (event.data?.type === "proxy-navigation" && event.data?.port === port) {
        const newUrl = event.data.url || `http://localhost:${port}${event.data.path || "/"}`;
        
        // Only add to history if different from current
        if (newUrl !== history[historyIndex]) {
          // Truncate forward history and add new URL
          const newHistory = [...history.slice(0, historyIndex + 1), newUrl];
          setHistory(newHistory);
          setHistoryIndex(newHistory.length - 1);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [port, history, historyIndex]);

  const handleGoBack = useCallback(() => {
    if (!canGoBack) return;
    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);
    
    // Navigate iframe to previous URL
    const prevPath = history[newIndex].replace(`http://localhost:${port}`, "");
    const iframeSrc = `${window.location.origin}/proxy/${port}${prevPath}`;
    if (iframeRef.current) {
      iframeRef.current.src = iframeSrc;
    }
  }, [canGoBack, historyIndex, history, port]);

  const handleGoForward = useCallback(() => {
    if (!canGoForward) return;
    const newIndex = historyIndex + 1;
    setHistoryIndex(newIndex);
    
    // Navigate iframe to next URL
    const nextPath = history[newIndex].replace(`http://localhost:${port}`, "");
    const iframeSrc = `${window.location.origin}/proxy/${port}${nextPath}`;
    if (iframeRef.current) {
      iframeRef.current.src = iframeSrc;
    }
  }, [canGoForward, historyIndex, history, port]);

  const handleRefresh = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
  }, []);

  return (
    <div className="h-[var(--app-height,100vh)] flex flex-col bg-slate-900">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 flex-shrink-0">
        {/* Close button */}
        <button
          onClick={onBack}
          className="p-2 bg-slate-700 hover:bg-red-600 text-white rounded transition"
          title="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* URL display */}
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="text-green-500 flex-shrink-0">●</span>
          <span className="text-slate-400 text-sm truncate" title={currentUrl}>
            {currentUrl}
          </span>
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleGoBack}
            disabled={!canGoBack}
            className={`p-2 rounded transition ${
              canGoBack 
                ? "bg-slate-700 hover:bg-slate-600 text-white" 
                : "bg-slate-700/50 text-slate-500 cursor-not-allowed"
            }`}
            title="Go back"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={handleGoForward}
            disabled={!canGoForward}
            className={`p-2 rounded transition ${
              canGoForward 
                ? "bg-slate-700 hover:bg-slate-600 text-white" 
                : "bg-slate-700/50 text-slate-500 cursor-not-allowed"
            }`}
            title="Go forward"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <button
            onClick={handleRefresh}
            className="p-2 bg-slate-700 hover:bg-slate-600 text-white rounded transition"
            title="Refresh"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Iframe */}
      <div className="flex-1 min-h-0">
        <iframe
          ref={iframeRef}
          src={proxyUrl}
          className="w-full h-full border-0"
          title={siteName || `Site on port ${port}`}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-top-navigation"
        />
      </div>
    </div>
  );
}
