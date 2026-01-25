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

      if (clientData.screenInterval) {
        clearInterval(clientData.screenInterval);
        clientData.screenInterval = null;
      }

      console.log("🚀 Remote streaming started");

      clientData.screenInterval = setInterval(async () => {
        try {
          const tiles = await clientData.tileManager.detectChangedTiles();
          if (tiles.length > 0) {
            const timestamp = Date.now();
            await this.screenUpdateHelper.sendTilesInChunks(socket, tiles, timestamp, false);
          }
        } catch (error) {
          console.error("Auto streaming error:", error);
        }
      }, 400);
    }));

    socket.on("stop-streaming", () => {
      const clientData = this.resourceManager.getClient(socket.id);
      if (!clientData) return;

      if (clientData.screenInterval) {
        clearInterval(clientData.screenInterval);
        clientData.screenInterval = null;
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
