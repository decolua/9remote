// Screen Update Helper for Remote Desktop
import { remoteConfig } from "../config.js";

export class ScreenUpdateHelper {
  constructor(resourceManager) {
    this.resourceManager = resourceManager;
  }

  async sendTilesInChunks(socket, tiles, timestamp, userAction = false) {
    if (!tiles || tiles.length === 0) return;
    
    const CHUNK_SIZE = remoteConfig.streaming.chunkSize;
    const chunks = [];
    
    for (let i = 0; i < tiles.length; i += CHUNK_SIZE) {
      chunks.push(tiles.slice(i, i + CHUNK_SIZE));
    }

    const clientChunkTimers = this.resourceManager.getChunkTimers(socket.id);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLastChunk = i === chunks.length - 1;
      
      const timerId = setTimeout(() => {
        clientChunkTimers.delete(timerId);
        
        if (socket.connected) {
          socket.emit("tiles-data", {
            tiles: chunk,
            timestamp: timestamp,
            forceRefresh: false,
            userAction: userAction,
            chunkInfo: {
              chunkIndex: i,
              totalChunks: chunks.length,
              isLastChunk: isLastChunk
            }
          });
        }
      }, i * remoteConfig.streaming.chunkDelay);
      
      clientChunkTimers.add(timerId);
    }
  }
}
