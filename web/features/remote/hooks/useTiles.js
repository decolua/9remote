"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

// Detect Chromium for createImageBitmap(blob) non-blocking path
const _isChromium = typeof window !== "undefined" && Boolean(window.chrome);

const makeTileBlob = (buf) => new Blob([buf], { type: "image/jpeg" });

const makeInvalidate = (ref, tileIndex) => () => { ref.current[tileIndex] = null; };

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

export function useTiles(socketRef, streaming, canvasRef) {
  const [totalTileCount, setTotalTileCount] = useState(126);
  const renderedTilesRef = useRef(new Set());
  const loadingTilesRef = useRef(new Map());
  const clientTileHashesRef = useRef([]);
  const isRequestingRef = useRef(false);
  const lastDataTimeRef = useRef(0);
  const batchTimeoutsRef = useRef(new Set());
  const cleanupTimeoutsRef = useRef(new Set());
  // Track latest timestamp per tileIndex — drop stale tiles before render
  const tileTimestampRef = useRef(new Map());

  // Shared rAF render queue — all ready bitmaps flush in ONE paint frame
  // Map<tileIndex, { bitmap, x, y, width, height, frameTs, invalidateTileHash }>
  const rafQueueRef = useRef(new Map());
  const rafIdRef = useRef(null);

  const streamingRef = useRef(streaming);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // Flush all pending bitmaps in ONE rAF — prevents N tiles = N paint frames
  const flushRafQueue = useCallback(() => {
    rafIdRef.current = null;
    const canvas = canvasRef?.current;
    if (!canvas) { rafQueueRef.current.clear(); return; }
    const ctx = canvas.getContext("2d");

    for (const [tileIndex, entry] of rafQueueRef.current) {
      const { bitmap, x, y, width, height, frameTs, invalidateTileHash } = entry;
      // Drop if a newer frame arrived while waiting
      if ((tileTimestampRef.current.get(tileIndex) ?? frameTs) > frameTs) {
        bitmap?.close?.();
        continue;
      }
      try {
        ctx.drawImage(bitmap, x, y, width, height);
        renderedTilesRef.current.add(tileIndex);
        bitmap?.close?.();
      } catch {
        invalidateTileHash();
      }
    }
    rafQueueRef.current.clear();
  }, [canvasRef]);

  const scheduleRaf = useCallback((forceReschedule = false) => {
    // For WebRTC: cancel and reschedule so we accumulate all chunks before flush
    if (forceReschedule && rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (rafIdRef.current) return;
    rafIdRef.current = requestAnimationFrame(flushRafQueue);
  }, [flushRafQueue]);

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

      // Update last data time for throttling
      lastDataTimeRef.current = Date.now();

      // Update client hashes from any response
      if (data.currentHashes && Array.isArray(data.currentHashes)) {
        clientTileHashesRef.current = data.currentHashes;
        isRequestingRef.current = false;
      }

      if (!data.tiles?.length) return;

      const frameTs = data.timestamp || Date.now();

      // Cancel loading tiles and update latest timestamp per tileIndex
      for (const tile of data.tiles) {
        const existing = loadingTilesRef.current.get(tile.tileIndex);
        // Only update timestamp if this frame is newer — prevents old batches from overwriting
        const prevTs = tileTimestampRef.current.get(tile.tileIndex) ?? 0;
        if (frameTs >= prevTs) {
          if (existing?.controller) existing.controller.cancelled = true;
          tileTimestampRef.current.set(tile.tileIndex, frameTs);
        }
      }

      // WebRTC path: bitmaps already decoded in Worker → enqueue directly, no delay
      // forceReschedule=true: cancel pending rAF so newer chunks can accumulate first
      if (data.hasBitmap !== undefined) {
        for (const tile of data.tiles) {
          if (!tile.bitmap && !tile.imageBuffer) continue;
          if ((tileTimestampRef.current.get(tile.tileIndex) ?? frameTs) > frameTs) {
            tile.bitmap?.close?.();
            continue;
          }
          const invalidateTileHash = makeInvalidate(clientTileHashesRef, tile.tileIndex);
          if (tile.bitmap) {
            rafQueueRef.current.set(tile.tileIndex, {
              bitmap: tile.bitmap, x: tile.x, y: tile.y,
              width: tile.width, height: tile.height,
              frameTs, invalidateTileHash
            });
          } else {
            _decodeTile(makeTileBlob(tile.imageBuffer))
              .then((bitmap) => {
                if (!bitmap) return;
                rafQueueRef.current.set(tile.tileIndex, {
                  bitmap, x: tile.x, y: tile.y,
                  width: tile.width, height: tile.height,
                  frameTs, invalidateTileHash
                });
                scheduleRaf(true);
              }).catch(() => { invalidateTileHash(); });
          }
        }
        scheduleRaf(true);
        return;
      }

      // WS path: imageBuffer/imageBase64 → batch decode with staggered delay
      const batches = [];
      for (let i = 0; i < data.tiles.length; i += REMOTE_CONFIG.batchSize) {
        batches.push(data.tiles.slice(i, i + REMOTE_CONFIG.batchSize));
      }

      batches.forEach((batch, batchIndex) => {
        const batchTimeoutId = setTimeout(() => {
          batchTimeoutsRef.current.delete(batchTimeoutId);
          batch.forEach((tile) => {
            if (!tile.imageBuffer && !tile.imageBase64) return;

            // Skip if a newer frame already arrived for this tile
            if ((tileTimestampRef.current.get(tile.tileIndex) ?? frameTs) > frameTs) {
              loadingTilesRef.current.delete(tile.tileIndex);
              return;
            }

            // Track loading for cancellation
            const controller = { cancelled: false };
            loadingTilesRef.current.set(tile.tileIndex, { controller });

            const timeoutId = setTimeout(() => {
              controller.cancelled = true;
              loadingTilesRef.current.delete(tile.tileIndex);
              clientTileHashesRef.current[tile.tileIndex] = null;
            }, REMOTE_CONFIG.tileLoadTimeout);

            const invalidateTileHash = makeInvalidate(clientTileHashesRef, tile.tileIndex);

            const drawBitmap = (bitmap) => {
              if (controller.cancelled || !canvasRef?.current) {
                bitmap?.close?.();
                return;
              }
              clearTimeout(timeoutId);
              loadingTilesRef.current.delete(tile.tileIndex);
              rafQueueRef.current.set(tile.tileIndex, {
                bitmap, x: tile.x, y: tile.y,
                width: tile.width, height: tile.height,
                frameTs, invalidateTileHash
              });
              scheduleRaf();
            };

            if (tile.imageBuffer && typeof createImageBitmap !== "undefined") {
              _decodeTile(makeTileBlob(tile.imageBuffer))
                .then(drawBitmap)
                .catch(() => {
                  if (controller.cancelled) return;
                  const img = new Image();
                  const url = URL.createObjectURL(makeTileBlob(tile.imageBuffer));
                  img.onload = () => { drawBitmap(img); URL.revokeObjectURL(url); };
                  img.onerror = () => {
                    URL.revokeObjectURL(url);
                    clearTimeout(timeoutId);
                    loadingTilesRef.current.delete(tile.tileIndex);
                    invalidateTileHash();
                  };
                  img.src = url;
                });
            } else {
              const img = new Image();
              if (tile.imageBuffer) {
                const url = URL.createObjectURL(makeTileBlob(tile.imageBuffer));
                img.onload = () => { drawBitmap(img); URL.revokeObjectURL(url); };
                img.onerror = () => {
                  URL.revokeObjectURL(url);
                  clearTimeout(timeoutId);
                  loadingTilesRef.current.delete(tile.tileIndex);
                  invalidateTileHash();
                };
                img.src = url;
              } else {
                img.onload = () => drawBitmap(img);
                img.onerror = () => {
                  clearTimeout(timeoutId);
                  loadingTilesRef.current.delete(tile.tileIndex);
                  invalidateTileHash();
                };
                img.src = tile.imageBase64;
              }
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
    if (!socketRef?.current || !streamingRef.current) return;
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
    tileTimestampRef.current.clear();
    lastDataTimeRef.current = 0;
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    rafQueueRef.current.clear();
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
