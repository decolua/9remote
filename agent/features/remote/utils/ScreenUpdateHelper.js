// Screen Update Helper for Remote Desktop
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";

export class ScreenUpdateHelper {
  constructor(resourceManager) {
    this.resourceManager = resourceManager;
  }

  async sendTilesInChunks(socket, tiles, timestamp, userAction = false) {
    if (!tiles || tiles.length === 0) return;
    
    const CHUNK_SIZE = REMOTE_CONFIG.streaming.chunkSize;
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
          // const totalBytes = chunk.reduce((sum, t) => sum + (t.imageBuffer?.length || 0), 0);
          socket.emit("tiles-data", {
            tiles: chunk,
            timestamp: timestamp,
            forceRefresh: false,
            userAction: userAction,
            chunkInfo: {
              chunkIndex: i,
              totalChunks: chunks.length,
              isLastChunk: isLastChunk,
              // bytes: totalBytes
            }
          });
        }
      }, i * REMOTE_CONFIG.streaming.chunkDelay);
      
      clientChunkTimers.add(timerId);
    }
  }
}
