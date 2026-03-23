"use client";

import { useRef, useCallback, useEffect, useState } from "react";

const INITIAL_STATS = {
  fps: 0,
  latency: 0,
  tilesPerSec: 0,
  bandwidthMBps: 0,
  webrtcTiles: 0,
  wsTiles: 0,
  webrtcPercent: 0
};

export function useBenchmark() {
  const [stats, setStats] = useState(INITIAL_STATS);

  const metricsRef = useRef({
    frameCount: 0,
    lastFpsTime: Date.now(),
    tilesReceived: 0,
    lastTilesTime: Date.now(),
    bytesReceived: 0,
    lastBandwidthTime: Date.now(),
    latencies: [],
    webrtcTilesTotal: 0,
    wsTilesTotal: 0
  });

  // Track tiles received
  const trackTilesReceived = useCallback((data, transport) => {
    const m = metricsRef.current;
    const now = Date.now();

    // Frame count for FPS
    m.frameCount++;

    // Tiles count
    const tileCount = data.tiles?.length || 0;
    m.tilesReceived += tileCount;

    // Bytes count
    const bytes = data.tiles?.reduce((sum, t) => sum + (t.imageBuffer?.byteLength || t.imageBuffer?.length || 0), 0) || 0;
    m.bytesReceived += bytes;

    // Latency - store with timestamp, keep 1 minute of data
    if (data.timestamp) {
      const latency = Date.now() - data.timestamp;
      m.latencies.push({ value: latency, time: now });
      // Remove latencies older than 1 minute
      m.latencies = m.latencies.filter(l => now - l.time < 60000);
    }

    // Transport tracking
    if (transport === "webrtc") {
      m.webrtcTilesTotal += tileCount;
    } else {
      m.wsTilesTotal += tileCount;
    }

    // Update stats every 500ms
    if (now - m.lastFpsTime >= 500) {
      const elapsed = (now - m.lastFpsTime) / 1000;
      const fps = Math.round(m.frameCount / elapsed);
      
      const avgLatency = m.latencies.length > 0
        ? Math.round(m.latencies.reduce((a, b) => a + b.value, 0) / m.latencies.length)
        : 0;

      const tilesPerSec = Math.round(m.tilesReceived / elapsed);
      const bandwidthMBps = (m.bytesReceived / elapsed / 1024 / 1024).toFixed(2);

      const totalTiles = m.webrtcTilesTotal + m.wsTilesTotal;
      const webrtcPercent = totalTiles > 0
        ? Math.round((m.webrtcTilesTotal / totalTiles) * 100)
        : 0;

      setStats({
        fps,
        latency: avgLatency,
        tilesPerSec,
        bandwidthMBps: parseFloat(bandwidthMBps),
        webrtcTiles: m.webrtcTilesTotal,
        wsTiles: m.wsTilesTotal,
        webrtcPercent
      });

      // Reset counters
      m.frameCount = 0;
      m.tilesReceived = 0;
      m.bytesReceived = 0;
      m.lastFpsTime = now;
    }
  }, []);

  const resetStats = useCallback(() => {
    const m = metricsRef.current;
    m.frameCount = 0;
    m.lastFpsTime = Date.now();
    m.tilesReceived = 0;
    m.lastTilesTime = Date.now();
    m.bytesReceived = 0;
    m.lastBandwidthTime = Date.now();
    m.latencies = [];
    m.webrtcTilesTotal = 0;
    m.wsTilesTotal = 0;
    
    setStats(INITIAL_STATS);
  }, []);

  return {
    stats,
    trackTilesReceived,
    resetStats
  };
}
