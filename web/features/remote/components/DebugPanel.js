"use client";

import { useState } from "react";
import { useI18n } from "@/shared/i18n";

export default function DebugPanel({ stats, mode, onReset, onClose, onCopy, onForceWsDisconnect, onToggleWsBlock, isWsBlocked }) {
  const { t } = useI18n();
  const [minimized, setMinimized] = useState(false);

  const getLatencyColor = (latency) => {
    if (latency < 50) return "text-green-400";
    if (latency < 100) return "text-yellow-400";
    return "text-red-400";
  };

  const getFpsColor = (fps) => {
    if (fps >= 15) return "text-green-400";
    if (fps >= 10) return "text-yellow-400";
    return "text-red-400";
  };

  const formatLatency = (ms) => {
    return `${Math.round(ms)}ms`;
  };

  if (minimized) {
    return (
      <div className="fixed top-4 right-4 z-50">
        <button
          onClick={() => setMinimized(false)}
          className="bg-surface-2 text-text px-4 py-2 rounded-lg shadow-md hover:bg-surface-3 transition-all duration-150 ease-out active:scale-[0.97]"
        >
          🔍 {t("remote.debug")}
        </button>
      </div>
    );
  }

  return (
    <div className="fixed top-4 right-4 z-50 card-elev p-4 min-w-[280px] text-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-border">
        <h3 className="text-text font-semibold flex items-center gap-2">
          🔍 {t("remote.debugTitle")}
        </h3>
        <div className="flex gap-2">
          <button
            onClick={() => setMinimized(true)}
            className="text-text-muted hover:text-text transition-colors"
            title={t("remote.minimize")}
          >
            ─
          </button>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text transition-colors"
            title={t("common.close")}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="space-y-2 mb-3">
        <div className="flex justify-between items-center">
          <span className="text-text-muted">Mode:</span>
          <span className={mode === "rtc" ? "text-blue-400 font-semibold" : "text-yellow-400 font-semibold"}>
            {mode === "rtc" ? "RTC enabled" : "WS only"}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-text-muted">{t("remote.transport")}:</span>
          <span className={stats.webrtcPercent > 50 ? "text-blue-400 font-semibold" : "text-text-muted"}>
            {stats.webrtcPercent > 50 ? "WebRTC ✅" : "WebSocket"}
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-text-muted">{t("remote.fps")}:</span>
          <span className={`font-semibold ${getFpsColor(stats.fps)}`}>
            {stats.fps}
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-text-muted">{t("remote.latency")}:</span>
          <span className={`font-semibold ${getLatencyColor(stats.latency)}`}>
            {formatLatency(stats.latency)}
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-text-muted">{t("remote.tilesPerSec")}:</span>
          <span className="text-text font-semibold">{stats.tilesPerSec}</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-text-muted">{t("remote.bandwidth")}:</span>
          <span className="text-text font-semibold">{stats.bandwidthMBps} MB/s</span>
        </div>
      </div>

      {/* Transport breakdown */}
      <div className="border-t border-border pt-3 mb-3 space-y-1">
        <div className="flex justify-between items-center text-xs">
          <span className="text-blue-400">WebRTC:</span>
          <span className="text-text-muted">
            {stats.webrtcTiles.toLocaleString()} tiles ({stats.webrtcPercent}%)
          </span>
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="text-text-muted">WebSocket:</span>
          <span className="text-text-muted">
            {stats.wsTiles.toLocaleString()} tiles ({100 - stats.webrtcPercent}%)
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 border-t border-border pt-3">
        <button
          onClick={onReset}
          className="flex-1 bg-surface hover:bg-surface-2 text-text py-2 px-3 rounded transition-colors text-xs"
        >
          {t("remote.clearStats")}
        </button>
        <button
          onClick={onCopy}
          className="flex-1 bg-surface hover:bg-surface-2 text-text py-2 px-3 rounded transition-colors text-xs"
        >
          Copy
        </button>
      </div>

      {/* Dev — WS disconnect / block to test RTC standalone */}
      {(onForceWsDisconnect || onToggleWsBlock) && (
        <div className="flex gap-2 mt-2">
          {onForceWsDisconnect && (
            <button
              onClick={onForceWsDisconnect}
              className="flex-1 bg-red-900/40 hover:bg-red-900/60 text-red-300 py-2 px-3 rounded transition-colors text-xs"
              title="Disconnect WS once (auto-reconnect)"
            >
              ⚡ Kill WS
            </button>
          )}
          {onToggleWsBlock && (
            <button
              onClick={onToggleWsBlock}
              className={`flex-1 py-2 px-3 rounded transition-colors text-xs ${isWsBlocked ? "bg-yellow-900/60 hover:bg-yellow-900/80 text-yellow-200" : "bg-surface hover:bg-surface-2 text-text"}`}
              title="Block WS reconnect to test RTC standalone"
            >
              {isWsBlocked ? "🔒 WS Blocked" : "🚫 Block WS"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
