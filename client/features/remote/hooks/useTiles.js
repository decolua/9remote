"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";

// Detect Chromium for createImageBitmap(blob) non-blocking path
const _isChromium = typeof window !== "undefined" && Boolean(window.chrome);

/**
 * Decode image blob to ImageBitmap off main thread (cross-browser).
 * Chrome: createImageBitmap(blob) is non-blocking.
 * Safari/Firefox: img.decode() + createImageBitmap(img) is non-blocking.
 * Fallback: new Image() for unsupported browsers.
 */
async function _decodeTile(blob) {
  if (typeof createImageBitmap === "undefined") return null;
  if (_isChromium) {
    return createImageBitmap(blob);
  }
  // Safari / Firefox path
  const img = new Image();
  const url = URL.createObjectURL(blob);
  img.src = url;
  await img.decode();
  const bitmap = await createImageBitmap(img);
  URL.revokeObjectURL(url);
  return bitmap;
}

export function useTiles(socket, streaming, canvasRef) {
  const [totalTileCount, setTotalTileCount] = useState(126);
  const renderedTilesRef = useRef(new Set());
  const loadingTilesRef = useRef(new Map());
  const clientTileHashesRef = useRef([]);
  const isRequestingRef = useRef(false);
  const lastDataTimeRef = useRef(0);
  const batchTimeoutsRef = useRef(new Set());
  const cleanupTimeoutsRef = useRef(new Set());

  const socketRef = useRef(socket);
  const streamingRef = useRef(streaming);

  useEffect(() => {
    socketRef.current = socket;
    streamingRef.current = streaming;
  }, [socket, streaming]);

  // Handle full screen data
  const handleFullScreenData = useCallback((data) => {
    if (!canvasRef?.current) return;

    try {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;

      const img = new Image();
      img.onload = () => {
        // Check canvas still valid before drawing
        if (!canvasRef?.current) return;
        try {
          ctx.drawImage(img, 0, 0, data.screen.width, data.screen.height);
          renderedTilesRef.current.clear();
          for (let i = 0; i < totalTileCount; i++) {
            renderedTilesRef.current.add(i);
          }
        } catch (e) {
          // Canvas may have been unmounted
        }
      };
      img.src = data.screen.imageBase64;
    } catch (error) {
      console.error("Full screen error:", error);
    }
  }, [canvasRef, totalTileCount]);

  // Handle tiles data
  const handleTilesData = useCallback((data) => {
    if (!canvasRef?.current) return;

    try {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;

      // Update last data time for throttling
      lastDataTimeRef.current = Date.now();

      // Update client hashes from any response
      if (data.currentHashes && Array.isArray(data.currentHashes)) {
        clientTileHashesRef.current = [...data.currentHashes];
        isRequestingRef.current = false;
      }

      if (!data.tiles?.length) return;

      // Cancel only tiles that overlap with incoming payload — leaves other tiles intact
      for (const tile of data.tiles) {
        const existing = loadingTilesRef.current.get(tile.tileIndex);
        if (existing?.controller) existing.controller.cancelled = true;
      }

      // Batch process tiles
      const batches = [];
      for (let i = 0; i < data.tiles.length; i += REMOTE_CONFIG.batchSize) {
        batches.push(data.tiles.slice(i, i + REMOTE_CONFIG.batchSize));
      }

      batches.forEach((batch, batchIndex) => {
        const batchTimeoutId = setTimeout(() => {
          batchTimeoutsRef.current.delete(batchTimeoutId);
          batch.forEach((tile) => {
            if (!tile.imageBuffer && !tile.imageBase64) return;

            const blob = tile.imageBuffer
              ? new Blob([tile.imageBuffer], { type: "image/jpeg" })
              : null;

            // Track loading for cancellation
            const controller = { cancelled: false };
            loadingTilesRef.current.set(tile.tileIndex, { controller, img: { src: "" } });

            const timeoutId = setTimeout(() => {
              controller.cancelled = true;
              loadingTilesRef.current.delete(tile.tileIndex);
              clientTileHashesRef.current[tile.tileIndex] = null;
            }, REMOTE_CONFIG.tileLoadTimeout);

            // Reset hash so next sync will re-request this tile
            const invalidateTileHash = () => {
              clientTileHashesRef.current[tile.tileIndex] = null;
            };

            const drawBitmap = (bitmap) => {
              if (controller.cancelled || !canvasRef?.current) {
                bitmap?.close?.();
                return;
              }
              clearTimeout(timeoutId);
              loadingTilesRef.current.delete(tile.tileIndex);

              requestAnimationFrame(() => {
                if (!canvasRef?.current) { bitmap?.close?.(); return; }
                try {
                  ctx.drawImage(bitmap, tile.x, tile.y, tile.width, tile.height);
                  renderedTilesRef.current.add(tile.tileIndex);
                  bitmap?.close?.();
                } catch (e) {
                  invalidateTileHash();
                }
              });
            };

            // Try createImageBitmap (non-blocking), fallback to new Image()
            if (blob && typeof createImageBitmap !== "undefined") {
              _decodeTile(blob)
                .then(drawBitmap)
                .catch(() => {
                  // Fallback: new Image() if createImageBitmap fails
                  if (controller.cancelled) return;
                  const img = new Image();
                  const url = URL.createObjectURL(blob);
                  img.onload = () => {
                    drawBitmap(img);
                    URL.revokeObjectURL(url);
                  };
                  img.onerror = () => {
                    URL.revokeObjectURL(url);
                    clearTimeout(timeoutId);
                    loadingTilesRef.current.delete(tile.tileIndex);
                    invalidateTileHash();
                  };
                  img.src = url;
                });
            } else {
              // Legacy fallback: base64 or no createImageBitmap support
              const img = new Image();
              img.onload = () => drawBitmap(img);
              img.onerror = () => {
                clearTimeout(timeoutId);
                loadingTilesRef.current.delete(tile.tileIndex);
                invalidateTileHash();
              };
              img.src = blob
                ? URL.createObjectURL(blob)
                : tile.imageBase64;
            }
          });
        }, batchIndex * REMOTE_CONFIG.batchDelay);
        batchTimeoutsRef.current.add(batchTimeoutId);
      });
    } catch (error) {
      console.error("Tiles data error:", error);
    }
  }, [canvasRef]);

  const startStreamingWithTiles = useCallback((startStreaming) => {
    startStreaming();
  }, []);

  const handleScreenDimensions = useCallback((dimensions) => {
    if (dimensions.tileCount) {
      setTotalTileCount(dimensions.tileCount);
    }
  }, []);

  const requestScreenWithHashes = useCallback(() => {
    if (!socketRef.current || !streamingRef.current) return;
    if (isRequestingRef.current) return;
    
    // Skip if recently received data (server is actively pushing)
    const timeSinceLastData = Date.now() - lastDataTimeRef.current;
    if (timeSinceLastData < REMOTE_CONFIG.lastDataThreshold && clientTileHashesRef.current.length > 0) {
      return;
    }

    isRequestingRef.current = true;
    socketRef.current.emit("request-screen-with-hashes", {
      tileHashes: clientTileHashesRef.current
    });

    const resetTimeoutId = setTimeout(() => {
      cleanupTimeoutsRef.current.delete(resetTimeoutId);
      isRequestingRef.current = false;
    }, 1000);
    cleanupTimeoutsRef.current.add(resetTimeoutId);
  }, []);

  const cleanupTiles = useCallback(() => {
    for (const [, tileData] of loadingTilesRef.current.entries()) {
      if (tileData.controller) tileData.controller.cancelled = true;
    }
    loadingTilesRef.current.clear();
    clientTileHashesRef.current = [];
    renderedTilesRef.current.clear();
    lastDataTimeRef.current = 0;
  }, []);

  // Cleanup all timeouts on unmount
  useEffect(() => {
    const batchTimeouts = batchTimeoutsRef.current;
    const cleanupTimeouts = cleanupTimeoutsRef.current;
    return () => {
      batchTimeouts.forEach(clearTimeout);
      batchTimeouts.clear();
      cleanupTimeouts.forEach(clearTimeout);
      cleanupTimeouts.clear();
    };
  }, []);

  return {
    renderedTilesRef,
    totalTileCount,
    handleFullScreenData,
    handleTilesData,
    startStreamingWithTiles,
    handleScreenDimensions,
    cleanupTiles,
    requestScreenWithHashes
  };
}
