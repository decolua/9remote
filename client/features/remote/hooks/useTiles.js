"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";

export function useTiles(socket, streaming, canvasRef) {
  const [totalTileCount, setTotalTileCount] = useState(126);
  const renderedTilesRef = useRef(new Set());
  const loadingTilesRef = useRef(new Map());
  const clientTileHashesRef = useRef([]);
  const isRequestingRef = useRef(false);

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
        ctx.drawImage(img, 0, 0, data.screen.width, data.screen.height);
        renderedTilesRef.current.clear();
        for (let i = 0; i < totalTileCount; i++) {
          renderedTilesRef.current.add(i);
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

      // Update client hashes
      if (data.currentHashes && Array.isArray(data.currentHashes)) {
        clientTileHashesRef.current = [...data.currentHashes];
        isRequestingRef.current = false;
      }

      // Cancel old loading tiles
      for (const [tileIndex, tileData] of loadingTilesRef.current.entries()) {
        if (tileData.timeoutId) clearTimeout(tileData.timeoutId);
        tileData.img.src = "";
      }
      loadingTilesRef.current.clear();

      if (!data.tiles?.length) return;

      // Batch process tiles
      const batches = [];
      for (let i = 0; i < data.tiles.length; i += REMOTE_CONFIG.batchSize) {
        batches.push(data.tiles.slice(i, i + REMOTE_CONFIG.batchSize));
      }

      batches.forEach((batch, batchIndex) => {
        setTimeout(() => {
          batch.forEach((tile) => {
            const img = new Image();

            const timeoutId = setTimeout(() => {
              loadingTilesRef.current.delete(tile.tileIndex);
              img.onload = null;
              img.onerror = null;
              img.src = "";
            }, REMOTE_CONFIG.tileLoadTimeout);

            loadingTilesRef.current.set(tile.tileIndex, { img, timeoutId });

            img.onload = () => {
              if (!loadingTilesRef.current.get(tile.tileIndex)) return;
              if (!img.complete || img.naturalWidth === 0) return;

              requestAnimationFrame(() => {
                ctx.drawImage(img, tile.x, tile.y, tile.width, tile.height);
                renderedTilesRef.current.add(tile.tileIndex);
              });

              const tileData = loadingTilesRef.current.get(tile.tileIndex);
              if (tileData?.timeoutId) clearTimeout(tileData.timeoutId);
              loadingTilesRef.current.delete(tile.tileIndex);

              setTimeout(() => {
                img.onload = null;
                img.onerror = null;
                img.src = "";
              }, 1000);
            };

            img.onerror = () => {
              const tileData = loadingTilesRef.current.get(tile.tileIndex);
              if (tileData?.timeoutId) clearTimeout(tileData.timeoutId);
              loadingTilesRef.current.delete(tile.tileIndex);
              img.onload = null;
              img.onerror = null;
              img.src = "";
            };

            img.src = tile.imageBase64;
          });
        }, batchIndex * REMOTE_CONFIG.batchDelay);
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

    isRequestingRef.current = true;
    socketRef.current.emit("request-screen-with-hashes", {
      tileHashes: clientTileHashesRef.current
    });

    setTimeout(() => {
      isRequestingRef.current = false;
    }, 1000);
  }, []);

  const cleanupTiles = useCallback(() => {
    for (const [, tileData] of loadingTilesRef.current.entries()) {
      if (tileData.timeoutId) clearTimeout(tileData.timeoutId);
      tileData.img.src = "";
    }
    loadingTilesRef.current.clear();
    clientTileHashesRef.current = [];
    renderedTilesRef.current.clear();
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
