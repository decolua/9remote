// Screen Handler for Remote Desktop

/**
 * Encode a single tile to binary for DataChannel transfer.
 * Format: [20-byte header + N-byte JPEG]
 * Header: tileIndex(4) x(4) y(4) width(4) height(4)
 */
function encodeTileBinary(tile) {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(tile.tileIndex, 0);
  header.writeUInt32LE(tile.x, 4);
  header.writeUInt32LE(tile.y, 8);
  header.writeUInt32LE(tile.width, 12);
  header.writeUInt32LE(tile.height, 16);
  return Buffer.concat([header, tile.imageBuffer]);
}

export class ScreenHandler {
  constructor(resourceManager, screenUpdateHelper, webrtcManager = null) {
    this.resourceManager = resourceManager;
    this.screenUpdateHelper = screenUpdateHelper;
    this.webrtcManager = webrtcManager;
  }

  /**
   * Send tiles via DataChannel if open, fallback to socket.emit.
   * Logs transport only when it changes (DC ↔ WS).
   */
  _sendTiles(socket, payload) {
    if (this.webrtcManager?.isReady(socket.id) && payload.tiles?.length > 0) {
      // Send each tile as a separate DC message — stays well under 64KB SCTP limit
      let allSent = true;
      for (const tile of payload.tiles) {
        const binary = encodeTileBinary(tile);
        const sent = this.webrtcManager.sendTile(socket.id, binary);
        if (!sent) { allSent = false; break; }
      }
      if (allSent) return;
    }
    socket.emit("tiles-data", payload);
  }

  setupScreenHandlers(socket, requireAuth) {
    socket.on("request-screen", requireAuth(async () => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;

      try {
        const changedTiles = await clientData.tileManager.detectChangedTiles();
        if (changedTiles.length > 0) {
          this._sendTiles(socket, { tiles: changedTiles, timestamp: Date.now() });
        }
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Tile capture error:", error);
        socket.emit("screen-error", { error: error.message });
      }
    }));

    socket.on("request-screen-with-hashes", requireAuth(async (data) => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;

      try {
        const clientTileHashes = data.tileHashes || [];
        const result = await clientData.tileManager.compareClientTileHashes(clientTileHashes);

        if (result?.tiles?.length > 0) {
          this._sendTiles(socket, {
            tiles: result.tiles,
            timestamp: Date.now(),
            currentHashes: result.currentHashes,
            changedIndices: result.changedIndices
          });
        } else {
          // Always send hashes update via WS (lightweight, no DC needed)
          socket.emit("tiles-data", {
            tiles: [],
            timestamp: Date.now(),
            currentHashes: result.currentHashes,
            changedIndices: []
          });
        }
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Tile capture with hashes error:", error);
        socket.emit("screen-error", { error: error.message });
      }
    }));

    socket.on("start-streaming", requireAuth(() => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;

      if (clientData.streamingTimeout) {
        clearTimeout(clientData.streamingTimeout);
        clientData.streamingTimeout = null;
      }

      console.log("🚀 Remote streaming started");

      // Adaptive streaming state
      clientData.idleFrameCount = 0;
      clientData.isStreaming = true;

      const streamLoop = async () => {
        if (!socket.connected || !clientData.isStreaming) {
          clientData.streamingTimeout = null;
          return;
        }

        try {
          const frameStart = performance.now();
          const result = await clientData.tileManager.detectChangedTilesWithHashes();
          const hasChanges = result.tiles.length > 0;

          if (hasChanges && socket.connected) {
            this._sendTiles(socket, {
              tiles: result.tiles,
              timestamp: Date.now(),
              currentHashes: result.currentHashes
            });
            clientData.idleFrameCount = 0;
          } else {
            clientData.idleFrameCount++;
          }

          // Adaptive interval: subtract processing time to hit target FPS
          const { activeInterval, idleInterval, idleThreshold } = this.resourceManager.getStreamingConfig();
          const baseInterval = clientData.idleFrameCount >= idleThreshold ? idleInterval : activeInterval;
          const nextInterval = Math.max(0, baseInterval - (performance.now() - frameStart));

          clientData.streamingTimeout = setTimeout(streamLoop, nextInterval);
        } catch (error) {
          console.error("Auto streaming error:", error);
          clientData.streamingTimeout = setTimeout(streamLoop, 200);
        }
      };

      // Start immediately
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
      console.log("⏹️ Remote streaming stopped");
    });

    socket.on("get-screen-dimensions", requireAuth(async () => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;

      try {
        const dimensions = await clientData.tileManager.getScreenDimensions();
        socket.emit("screen-dimensions", dimensions);
      } catch (error) {
        console.error("Get dimensions error:", error);
        socket.emit("screen-error", { error: error.message });
      }
    }));

    // Boost stream - reset idle to speed up streaming immediately
    socket.on("boost-stream", requireAuth(() => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;
      clientData.idleFrameCount = 0;
    }));
  }
}
