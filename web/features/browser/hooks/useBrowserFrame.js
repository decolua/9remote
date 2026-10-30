"use client";

// Paints binary browser frames onto a canvas by reusing Remote Desktop's useTiles hook:
// - Tile batches: decoded via tileDecoder.worker off main thread,
//   batched in rAF, drawn to canvas via ctx.drawImage, auto-acked.
// - Periodic repair: sends clientTileHashes via browser:request-tiles-hashes.
import { useEffect, useRef, useState } from "react";
import { useTiles } from "@/features/remote/hooks/useTiles";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

// canvasRef / frameRef may be injected (the pane shares them with the remote surface);
// applyDimensions({width,height}, renderedTilesRef) lets that surface own canvas sizing.
export function useBrowserFrame({ busRef, connected, targetId, onPainted, canvasRef: extCanvasRef, frameRef: extFrameRef, applyDimensions }) {
  const ownCanvasRef = useRef(null);
  const canvasRef = extCanvasRef || ownCanvasRef;
  const [frame, setFrame] = useState(null);
  const ownFrameRef = useRef(null);
  const frameRef = extFrameRef || ownFrameRef;
  // Tiles carry no target id on the wire — frameTargetRef names the tab the
  // canvas state belongs to; dimsForRef gates tile batches to the tab whose
  // dims (always sent first by a fresh stream) have arrived.
  const frameTargetRef = useRef(null);
  const dimsForRef = useRef(null);
  const onPaintedRef = useRef(onPainted);
  useEffect(() => { onPaintedRef.current = onPainted; }, [onPainted]);

  // Clone 100% of Remote Desktop's useTiles hook
  const tiles = useTiles(busRef, connected && !!targetId, canvasRef, {
    ackEvent: "browser:stream.ack",
    verifyEvent: "browser:request-tiles-hashes",
    targetId,
    resetWorker: false
  });

  const {
    hasFrame,
    handleTilesData,
    handleTilesBinaryV2,
    cleanupTiles,
    requestScreenWithHashes,
    handleScreenDimensions,
    renderedTilesRef
  } = tiles;

  // eslint-disable-next-line react-hooks/immutability -- frameRef is an injected ref (shared with the remote surface); nulling it on a tab switch mirrors the mutation onDimensions already does
  useEffect(() => {
    const bus = busRef?.current;
    if (!connected || !bus?.on || !targetId) return;

    cleanupTiles();
    let stopped = false;
    // New tab: the canvas still shows the OLD tab's pixels — blank it, drop the
    // frame state (the pane's loading overlay returns) and ignore tile batches
    // until this tab's dims arrive: late tiles from the stopped stream (unordered
    // lane, no target id on the wire) must not paint over the new tab.
    if (frameTargetRef.current !== targetId) {
      frameTargetRef.current = targetId;
      dimsForRef.current = null;
      frameRef.current = null;
      setFrame(null);
      const el = canvasRef.current;
      if (el?.width) el.getContext("2d").clearRect(0, 0, el.width, el.height);
    }

    const onTilesData = (data) => {
      if (stopped) return;
      if (dimsForRef.current !== targetId) return;
      handleTilesData(data);
      onPaintedRef.current?.({}, data.bytes);
    };

    const onTilesBin = (buffer) => {
      if (stopped) return;
      if (dimsForRef.current !== targetId) return;
      handleTilesBinaryV2(buffer);
      onPaintedRef.current?.({}, buffer?.byteLength || 0);
    };

    // Host announces the REAL raster size (tiles live in it) and the page's CSS
    // viewport (input mapping reads meta.deviceWidth/Height). Tiles carry neither.
    const onDimensions = (dims) => {
      if (stopped || dims?.targetId !== targetId || !dims.frameW || !dims.frameH) return;
      dimsForRef.current = targetId;
      const prev = frameRef.current;
      const resized = !prev || prev.w !== dims.frameW || prev.h !== dims.frameH;
      // A remounted canvas (pane reconnect) comes back at its default size.
      const el = canvasRef.current;
      const canvasStale = !!el && (el.width !== dims.frameW || el.height !== dims.frameH);
      const next = {
        w: dims.frameW,
        h: dims.frameH,
        meta: { ...(prev?.meta || {}), deviceWidth: dims.deviceWidth, deviceHeight: dims.deviceHeight }
      };
      frameRef.current = next;
      if (!resized && !canvasStale) return;
      // New grid: old hashes/tiles are meaningless. Resizing a canvas also clears it,
      // so ask for a full repaint right away (tiles may have beaten this message).
      cleanupTiles();
      handleScreenDimensions({ tileCount: dims.tileCount });
      setFrame(next);
      if (applyDimensions) {
        applyDimensions({ width: dims.frameW, height: dims.frameH }, renderedTilesRef);
      } else if (canvasRef.current) {
        canvasRef.current.width = dims.frameW;
        canvasRef.current.height = dims.frameH;
      }
      bus.emit?.("browser:request-tiles-hashes", { targetId, tileHashes: [] });
    };

    bus.on?.("browser:tiles-data", onTilesData);
    bus.on?.("browser:tiles-bin", onTilesBin);
    bus.on?.("browser:screen-dimensions", onDimensions);

    // Periodic verify-repair (Remote Desktop's hash request loop)
    const verifyInterval = setInterval(() => {
      if (stopped || (typeof document !== "undefined" && document.hidden)) return;
      if (renderedTilesRef.current.size === 0) {
        bus.emit?.("browser:request-tiles-hashes", { targetId, tileHashes: [] });
      } else {
        requestScreenWithHashes();
      }
    }, REMOTE_CONFIG.hashRequestInterval);

    return () => {
      stopped = true;
      bus.off?.("browser:tiles-data", onTilesData);
      bus.off?.("browser:tiles-bin", onTilesBin);
      bus.off?.("browser:screen-dimensions", onDimensions);
      clearInterval(verifyInterval);
      cleanupTiles();
    };
  }, [busRef, connected, targetId, cleanupTiles, handleTilesData, handleTilesBinaryV2, handleScreenDimensions, requestScreenWithHashes, renderedTilesRef, canvasRef, frameRef, applyDimensions]);

  return {
    canvasRef,
    frame: (hasFrame || frame) ? (frame || { w: 1280, h: 720 }) : null,
    frameRef
  };
}
