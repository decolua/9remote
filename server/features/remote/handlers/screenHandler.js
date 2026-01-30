// Screen Handler for Remote Desktop

export class ScreenHandler {
  constructor(resourceManager, screenUpdateHelper) {
    this.resourceManager = resourceManager;
    this.screenUpdateHelper = screenUpdateHelper;
  }

  setupScreenHandlers(socket, requireAuth) {
    socket.on("request-screen", requireAuth(async () => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;

      try {
        const changedTiles = await clientData.tileManager.detectChangedTiles();
        if (changedTiles.length > 0) {
          socket.emit("tiles-data", { tiles: changedTiles, timestamp: Date.now() });
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
          socket.emit("tiles-data", {
            tiles: result.tiles,
            timestamp: Date.now(),
            currentHashes: result.currentHashes,
            changedIndices: result.changedIndices
          });
        } else {
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
          const result = await clientData.tileManager.detectChangedTilesWithHashes();
          const hasChanges = result.tiles.length > 0;

          if (hasChanges && socket.connected) {
            socket.emit("tiles-data", {
              tiles: result.tiles,
              timestamp: Date.now(),
              currentHashes: result.currentHashes
            });
            clientData.idleFrameCount = 0;
          } else {
            clientData.idleFrameCount++;
          }

          // Adaptive interval: fast when active, slower when idle
          const { activeInterval, idleInterval, idleThreshold } = this.resourceManager.getStreamingConfig();
          const nextInterval = clientData.idleFrameCount >= idleThreshold ? idleInterval : activeInterval;

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
  }
}
