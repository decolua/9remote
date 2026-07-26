/**
 * Encode a single tile to binary (v2).
 * Format: [28-byte header + N-byte JPEG]
 *   tileIndex(4) x(4) y(4) width(4) height(4) imageSize(4) hash(4)
 */
function encodeTileBinary(tile) {
  const header = Buffer.alloc(28);
  header.writeUInt32LE(tile.tileIndex, 0);
  header.writeUInt32LE(tile.x, 4);
  header.writeUInt32LE(tile.y, 8);
  header.writeUInt32LE(tile.width, 12);
  header.writeUInt32LE(tile.height, 16);
  header.writeUInt32LE(tile.imageBuffer.length, 20);
  header.writeUInt32LE(tile.hash >>> 0, 24);
  return Buffer.concat([header, tile.imageBuffer]);
}

/**
 * Encode batch of tiles to binary (v2 — embeds hash per tile).
 * Format: [4B tileCount] + [8B timestamp Float64BE] + tile binaries
 */
export function encodeTilesBatch(tiles, timestamp) {
  const batchHeader = Buffer.alloc(12);
  batchHeader.writeUInt32LE(tiles.length, 0);
  batchHeader.writeDoubleBE(timestamp, 4);
  return Buffer.concat([batchHeader, ...tiles.map(encodeTileBinary)]);
}

import { remoteLog } from "../utils/remoteLog.js";
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";
import { pushUiLog } from "../../../api/ui.js";

export class ScreenHandler {
  constructor(resourceManager, screenUpdateHelper) {
    this.resourceManager = resourceManager;
    this.screenUpdateHelper = screenUpdateHelper;
  }

  setupScreenHandlers(socket, requireAuth, protocol) {
    socket.on("select_monitor", requireAuth(async (data) => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData?.monitorManager) return;
      const index = typeof data?.index === "number" ? data.index : null;
      if (index === null || !clientData.monitorManager.setActive(index)) return;
      const entry = clientData.monitorManager.getActive();
      if (!entry) return;

      // Switch the TileManager to the new monitor: this recomputes the tile
      // grid and clears all cached state so the next frame is a full refresh.
      clientData.tileManager.setMonitor(entry.mon);

      // Tell the client the new canvas size + tag the upcoming frame so it can
      // swap its canvas before the first tiles of this monitor arrive. Dimensions
      // come straight from metadata (no capture) so this can't fail mid-switch.
      const tm = clientData.tileManager;
      protocol.emit("screen-dimensions", {
        width: tm.scaledWidth,
        height: tm.scaledHeight,
        tileWidth: tm.tileSize,
        tileHeight: tm.tileSize,
        tileCount: tm.totalTiles,
        scaleFactor: tm.scaleFactor,
        originalWidth: tm.screenWidth,
        originalHeight: tm.screenHeight
      });
      protocol.emit("frame_meta", {
        monitorIndex: entry.index,
        captureW: entry.w,
        captureH: entry.h
      });

      clientData.idleFrameCount = 0;
      this.resourceManager.updateClientActivity(socket.id);
      remoteLog.lifecycle(`🖥️ Monitor switched → #${entry.index} (${entry.name} ${entry.w}x${entry.h})`);
    }));

    socket.on("request-screen", requireAuth(async () => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;
      try {
        const changedTiles = await clientData.tileManager.detectChangedTiles();
        if (changedTiles.length > 0) {
          protocol.sendTiles({ tiles: changedTiles, timestamp: Date.now() }, encodeTilesBatch);
        }
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        remoteLog.error("Tile capture error:", error);
        protocol.emit("screen-error", { error: error.message });
      }
    }));

    socket.on("request-screen-with-hashes", requireAuth(async (data) => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;
      try {
        const clientTileHashes = data.tileHashes || [];
        const result = await clientData.tileManager.compareClientTileHashes(clientTileHashes);

        if (result?.tiles?.length > 0) {
          protocol.sendTiles({
            tiles: result.tiles,
            timestamp: Date.now()
          }, encodeTilesBatch);
        }
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        remoteLog.error("Tile capture with hashes error:", error);
        protocol.emit("screen-error", { error: error.message });
      }
    }));

    socket.on("start-streaming", requireAuth(async () => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;

      if (clientData.streamingTimeout) {
        clearTimeout(clientData.streamingTimeout);
        clientData.streamingTimeout = null;
      }

      remoteLog.lifecycle("🚀 Remote streaming started");
      // Surface active tile codec in /logs to verify WebP is live (once per stream start)
      const { tileFormat, webpEffort, jpegQuality } = REMOTE_CONFIG.pipeline;
      pushUiLog(`🖼️ Remote stream codec: ${tileFormat.toUpperCase()}${tileFormat === "webp" ? ` (effort=${webpEffort})` : ""} q=${jpegQuality}`);
      clientData.idleFrameCount = 0;
      clientData.isStreaming = true;
      // Bump generation so any leftover loop self-exits (prevents 2 loops sharing isProcessing)
      clientData.streamGen = (clientData.streamGen || 0) + 1;
      const myGen = clientData.streamGen;

      // Reset tile hashes so server sends a full frame on restart
      clientData.tileManager.lastTileChecksums.clear();

      try {
        const dimensions = await clientData.tileManager.getScreenDimensions();
        protocol.emit("screen-dimensions", dimensions);
      } catch (err) {
        remoteLog.error("Get dimensions error:", err);
      }

      const streamLoop = async () => {
        if (!socket.connected || !clientData.isStreaming || clientData.streamGen !== myGen) {
          clientData.streamingTimeout = null;
          return;
        }
        // App-level flow control (window=N): if N frames are already in flight,
        // wait — caps the hidden SCTP queue so it can't grow into multi-second
        // delay (bufferedAmount doesn't reflect the SCTP buffer).
        clientData.inFlight ??= new Set();
        if (clientData.inFlight.size >= REMOTE_CONFIG.webrtc.ackWindow) {
          clientData.streamingTimeout = setTimeout(streamLoop, REMOTE_CONFIG.webrtc.ackPollMs);
          return;
        }
        try {
          const frameStart = performance.now();
          const frameTs = Date.now();
          const result = await clientData.tileManager.detectChangedTilesWithHashes();

            if (result.tiles.length > 0 && socket.connected) {
              const sent = protocol.sendTiles({ tiles: result.tiles, timestamp: frameTs, currentHashes: result.currentHashes }, encodeTilesBatch);
              clientData.tileManager.commitHashes(sent || []);
              clientData.idleFrameCount = 0;
              // Mark frame in-flight; cleared by "tile-ack" (browser) or per-frame timeout.
              if (sent?.length) {
                clientData.inFlight.add(frameTs);
                clientData.ackTimers ??= new Map();
                const timer = setTimeout(() => {
                  clientData.inFlight.delete(frameTs);
                  clientData.ackTimers.delete(frameTs);
                }, REMOTE_CONFIG.webrtc.ackTimeoutMs);
                clientData.ackTimers.set(frameTs, timer);
              }
            } else {
            clientData.idleFrameCount++;
          }

          const { activeInterval, idleInterval, idleThreshold } = this.resourceManager.getStreamingConfig();
          const baseInterval = clientData.idleFrameCount >= idleThreshold ? idleInterval : activeInterval;
          const nextInterval = Math.max(0, baseInterval - (performance.now() - frameStart));
          clientData.streamingTimeout = setTimeout(streamLoop, nextInterval);
        } catch (error) {
          remoteLog.error("Auto streaming error:", error);
          clientData.streamingTimeout = setTimeout(streamLoop, 200);
        }
      };

      streamLoop();
    }));

    socket.on("stop-streaming", () => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;
      clientData.isStreaming = false;
      if (clientData.streamingTimeout) {
        clearTimeout(clientData.streamingTimeout);
        clientData.streamingTimeout = null;
      }
      clientData.inFlight?.clear?.();
      if (clientData.ackTimers) {
        for (const t of clientData.ackTimers.values()) clearTimeout(t);
        clientData.ackTimers.clear();
      }
    // Release screen buffers while idle — first frame after restart is full refresh
    clientData.tileManager?.clearMemory?.();
    remoteLog.lifecycle("⏹️ Remote streaming stopped");
  });

    // Browser acks a rendered frame → release all in-flight frames with ts <= ack
    // (those have been painted) so the window frees up for the next frame.
    socket.on("tile-ack", requireAuth((data) => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;
      const ts = data?.ts;
      if (typeof ts !== "number") return;
      clientData.inFlight ??= new Set();
      clientData.ackTimers ??= new Map();
      for (const fts of [...clientData.inFlight]) {
        if (fts <= ts) {
          clientData.inFlight.delete(fts);
          const timer = clientData.ackTimers.get(fts);
          if (timer) { clearTimeout(timer); clientData.ackTimers.delete(fts); }
        }
      }
    }));

    socket.on("get-screen-dimensions", requireAuth(async () => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;
      try {
        const dimensions = await clientData.tileManager.getScreenDimensions();
        protocol.emit("screen-dimensions", dimensions);
        // Re-send monitor list: the initial "monitors" emit on socket setup
        // races the client's listener registration (client opens the remote UI
        // after connect), so the first event is lost and the switcher never
        // renders. get-screen-dimensions is emitted on every mount, so
        // piggyback here to guarantee the list reaches an active listener.
        // refresh() re-detects displays first, so plug/unplug after connect
        // shows up without restarting the agent.
        if (clientData.monitorManager) {
          clientData.monitorManager.refresh();
          protocol.emit("monitors", {
            list: clientData.monitorManager.list(),
            activeIndex: clientData.monitorManager.getActiveIndex()
          });
        }
      } catch (error) {
        remoteLog.error("Get dimensions error:", error);
        protocol.emit("screen-error", { error: error.message });
      }
    }));

    socket.on("boost-stream", requireAuth(() => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;
      clientData.idleFrameCount = 0;
    }));

    socket.on("set-focus", requireAuth((data) => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;
      const rect = data?.rect || null;
      // Adaptive quality — pick tier from effective pixel density (viewer/agent ratio)
      const zoom = typeof data?.zoom === "number" ? data.zoom : 1;
      const viewerWidth = typeof data?.viewerWidth === "number" ? data.viewerWidth : 0;
      const dpr = typeof data?.dpr === "number" ? data.dpr : 1;
      const profile = clientData.tileManager.pickProfile({ zoom, viewerWidth, dpr });
      clientData.tileManager.setProfile(profile);
      clientData.tileManager.setFocusRect(rect);
      if (rect) {
        const active = clientData.tileManager.activeTileSet?.size || 0;
        const total = clientData.tileManager.totalTiles;
        const pct = total ? ((active / total) * 100).toFixed(0) : 0;
        remoteLog.focus(`🎯 [Focus] rect=${rect.x},${rect.y} ${rect.w}x${rect.h} | tiles ${active}/${total} (${pct}%)`);
      } else {
        remoteLog.focus("🎯 [Focus] cleared → full screen");
      }
    }));
  }
}
