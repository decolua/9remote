"use client";

import { useState } from "react";

export default function DebugPanel({ stats, onReset, onClose }) {
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
          className="bg-dark-600 text-white px-4 py-2 rounded-lg shadow-lg border border-dark-500 hover:bg-dark-500 transition-colors"
        >
          🔍 Debug
        </button>
      </div>
    );
  }

  return (
    <div className="fixed top-4 right-4 z-50 bg-dark-700 border border-dark-500 rounded-lg shadow-2xl p-4 min-w-[280px] text-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-dark-600">
        <h3 className="text-white font-semibold flex items-center gap-2">
          🔍 Debug Stats
        </h3>
        <div className="flex gap-2">
          <button
            onClick={() => setMinimized(true)}
            className="text-gray-400 hover:text-white transition-colors"
            title="Minimize"
          >
            ─
          </button>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="space-y-2 mb-3">
        <div className="flex justify-between items-center">
          <span className="text-gray-400">Transport:</span>
          <span className={stats.webrtcPercent > 50 ? "text-blue-400 font-semibold" : "text-gray-300"}>
            {stats.webrtcPercent > 50 ? "WebRTC ✅" : "WebSocket"}
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-gray-400">FPS:</span>
          <span className={`font-semibold ${getFpsColor(stats.fps)}`}>
            {stats.fps}
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-gray-400">Latency:</span>
          <span className={`font-semibold ${getLatencyColor(stats.latency)}`}>
            {formatLatency(stats.latency)}
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-gray-400">Tiles/sec:</span>
          <span className="text-white font-semibold">{stats.tilesPerSec}</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-gray-400">Bandwidth:</span>
          <span className="text-white font-semibold">{stats.bandwidthMBps} MB/s</span>
        </div>
      </div>

      {/* Transport breakdown */}
      <div className="border-t border-dark-600 pt-3 mb-3 space-y-1">
        <div className="flex justify-between items-center text-xs">
          <span className="text-blue-400">WebRTC:</span>
          <span className="text-gray-300">
            {stats.webrtcTiles.toLocaleString()} tiles ({stats.webrtcPercent}%)
          </span>
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-400">WebSocket:</span>
          <span className="text-gray-300">
            {stats.wsTiles.toLocaleString()} tiles ({100 - stats.webrtcPercent}%)
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 border-t border-dark-600 pt-3">
        <button
          onClick={onReset}
          className="flex-1 bg-dark-600 hover:bg-dark-500 text-white py-2 px-3 rounded transition-colors text-xs"
        >
          Clear Stats
        </button>
      </div>
    </div>
  );
}
