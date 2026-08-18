"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useI18n } from "@/shared/i18n";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";

export default function SiteView({ port, siteName, onBack, tunnelUrl }) {
  const { t } = useI18n();
  const { getAuth } = useSessionStorage();
  const baseUrl = tunnelUrl || (typeof window !== "undefined" ? window.location.origin : "");
  const proxyUrl = `${baseUrl}/proxy/${port}/`;
  const iframeRef = useRef(null);
  const windowRef = useRef(null);
  const checkIntervalRef = useRef(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [isWindowOpen, setIsWindowOpen] = useState(false);
  
  // History tracking
  const [history, setHistory] = useState([`http://localhost:${port}/`]);
  const [historyIndex, setHistoryIndex] = useState(0);
  
  const currentUrl = history[historyIndex] || `http://localhost:${port}/`;
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  // Start/end proxy session on mount/unmount
  useEffect(() => {
    const startSession = async () => {
      try {
        await fetch(`${baseUrl}/api/proxy/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${getAuth()?.apiKey}` },
          body: JSON.stringify({ port })
        });
        setSessionReady(true);
      } catch (err) {
        console.error("Failed to start proxy session:", err);
      }
    };

    startSession();

    return () => {
      fetch(`${baseUrl}/api/proxy/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${getAuth()?.apiKey}` },
        body: JSON.stringify({ port })
      }).catch(() => {});
    };
  }, [baseUrl, port, getAuth]);

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

  const handleOpenInNewTab = useCallback(() => {
    console.log("[SiteView] Opening new tab, proxyUrl:", proxyUrl);
    
    if (windowRef.current && !windowRef.current.closed) {
      console.log("[SiteView] Window already open, focusing...");
      windowRef.current.focus();
      return;
    }

    windowRef.current = window.open(proxyUrl, `_proxy_${port}`, "noopener,noreferrer");
    
    if (!windowRef.current) {
      console.error("[SiteView] Failed to open window - popup may be blocked");
      alert(t("sites.popupBlocked"));
      return;
    }
    
    console.log("[SiteView] Window opened successfully");
    setIsWindowOpen(true);

    // Start polling to check if window is closed
    checkIntervalRef.current = setInterval(() => {
      if (windowRef.current && windowRef.current.closed) {
        console.log("[SiteView] Window closed, cleaning up...");
        clearInterval(checkIntervalRef.current);
        setIsWindowOpen(false);
        windowRef.current = null;

        // Call cleanup API
        fetch(`${baseUrl}/api/proxy/end`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${getAuth()?.apiKey}` },
          body: JSON.stringify({ port })
        }).catch((err) => {
          console.error("[SiteView] Cleanup failed:", err);
        });
      }
    }, 1000);
  }, [proxyUrl, port, baseUrl, getAuth, t]);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
      }
    };
  }, []);

  return (
    <div className="h-[var(--app-height,100vh)] flex flex-col bg-bg">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex items-center gap-3 flex-shrink-0">
        {/* Close button */}
        <button
          onClick={onBack}
          className="p-2 bg-surface-2 hover:bg-red-600 text-text rounded transition"
          title={t("common.close")}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* URL display */}
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="text-green-500 flex-shrink-0">●</span>
          <span className="text-text-muted text-sm truncate" title={currentUrl}>
            {currentUrl}
          </span>
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleOpenInNewTab}
            className={`p-2 rounded transition ${
              isWindowOpen
                ? "bg-blue-600 hover:bg-blue-700 text-text"
                : "bg-surface-2 hover:bg-surface-2 text-text"
            }`}
            title={isWindowOpen ? t("sites.focusOpenedTab") : t("sites.openInNewTab")}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </button>
          <button
            onClick={handleGoBack}
            disabled={!canGoBack}
            className={`p-2 rounded transition ${
              canGoBack 
                ? "bg-surface-2 hover:bg-surface-2 text-text" 
                : "bg-surface/50 text-text-subtle cursor-not-allowed"
            }`}
            title={t("sites.goBack")}
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
                ? "bg-surface-2 hover:bg-surface-2 text-text" 
                : "bg-surface/50 text-text-subtle cursor-not-allowed"
            }`}
            title={t("sites.goForward")}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <button
            onClick={handleRefresh}
            className="p-2 bg-surface-2 hover:bg-surface-2 text-text rounded transition"
            title={t("sites.refresh")}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Iframe */}
      <div className="flex-1 min-h-0">
        {sessionReady ? (
          <iframe
            ref={iframeRef}
            src={proxyUrl}
            className="w-full h-full border-0"
            title={siteName || `Site on port ${port}`}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-top-navigation"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-text-muted">
            {t("sites.loadingSite")}
          </div>
        )}
      </div>
    </div>
  );
}
