// Screen Handler for Remote Desktop

/**
 * Encode a single tile to binary for DataChannel transfer.
 * Format: [24-byte header + N-byte JPEG]
 * Header: tileIndex(4) x(4) y(4) width(4) height(4) imageSize(4)
 */
function encodeTileBinary(tile) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(tile.tileIndex, 0);
  header.writeUInt32LE(tile.x, 4);
  header.writeUInt32LE(tile.y, 8);
  header.writeUInt32LE(tile.width, 12);
  header.writeUInt32LE(tile.height, 16);
  header.writeUInt32LE(tile.imageBuffer.length, 20);
  return Buffer.concat([header, tile.imageBuffer]);
}

/**
 * Encode batch tiles to binary for DataChannel transfer.
 * Format: [4-byte tileCount] + [8-byte timestamp Float64BE] + [tile1 binary] + ...
 * Each tile: [24-byte header + N-byte JPEG]
 * timestamp is passed in so all chunks of the same frame share the same value.
 */
function encodeTilesBatch(tiles, timestamp) {
  const batchHeader = Buffer.alloc(12);
  batchHeader.writeUInt32LE(tiles.length, 0);
  batchHeader.writeDoubleBE(timestamp, 4);

  const encodedTiles = tiles.map(tile => encodeTileBinary(tile));
  return Buffer.concat([batchHeader, ...encodedTiles]);
}

export class ScreenHandler {
  constructor(resourceManager, screenUpdateHelper, webrtcManager = null) {
    this.resourceManager = resourceManager;
    this.screenUpdateHelper = screenUpdateHelper;
    this.webrtcManager = webrtcManager;
  }

  /**
   * Send tiles via DataChannel if open, fallback to socket.emit.
   * WebRTC: chunks tiles by dcChunkSize to stay under 64KB SCTP limit.
   */
  _sendTiles(socket, payload) {
    if (this.webrtcManager?.isReady(socket.id) && payload.tiles?.length > 0) {
      const { dcChunkSize, dcMaxTilesPerFrame } = this.resourceManager.getWebRTCConfig();

      // Fallback to WS when too many tiles — DC can't drain fast enough
      if (payload.tiles.length > dcMaxTilesPerFrame) {
        socket.emit("tiles-data", payload);
        return;
      }

      const frameTs = payload.timestamp ?? Date.now();
      const chunks = [];
      for (let i = 0; i < payload.tiles.length; i += dcChunkSize) {
        chunks.push(encodeTilesBatch(payload.tiles.slice(i, i + dcChunkSize), frameTs));
      }
      this.webrtcManager.sendFrame(socket.id, chunks);
      return;
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
