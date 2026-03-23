// Resource Manager for Remote Desktop
import { REMOTE_CONFIG } from "./REMOTE_CONFIG.js";

export class ResourceManager {
  constructor() {
    this.activeClients = new Map();
    this.activeTimers = new Map();
    this.chunkTimers = new Map();
    this.memoryCheckInterval = null;
  }

  startResourceMonitoring() {
    this.memoryCheckInterval = setInterval(() => {
      const usage = process.memoryUsage();
      const memoryMB = Math.round(usage.heapUsed / 1024 / 1024);
      
      if (memoryMB > REMOTE_CONFIG.resourceManagement.memoryWarningThreshold) {
        console.warn(`⚠️ High memory: ${memoryMB}MB`);
        this.cleanupInactiveClients();
      }
    }, REMOTE_CONFIG.resourceManagement.memoryCheckInterval);
  }

  stopResourceMonitoring() {
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
      this.memoryCheckInterval = null;
    }
  }

  addClient(socketId, clientData) {
    this.activeClients.set(socketId, {
      ...clientData,
      lastActivity: Date.now()
    });
  }

  getClient(socketId) {
    return this.activeClients.get(socketId);
  }

  updateClientActivity(socketId) {
    const clientData = this.activeClients.get(socketId);
    if (clientData) {
      clientData.lastActivity = Date.now();
    }
  }

  cleanupInactiveClients() {
    const now = Date.now();
    const inactiveTimeout = REMOTE_CONFIG.resourceManagement.inactiveTimeout;
    
    for (const [socketId, clientData] of this.activeClients.entries()) {
      if (now - clientData.lastActivity > inactiveTimeout) {
        console.log(`🧹 Cleaning inactive client: ${socketId}`);
        this.cleanupClientResources(socketId, clientData);
        this.activeClients.delete(socketId);
      }
    }
  }

  cleanupClientResources(socketId, clientData) {
    try {
      // Stop adaptive streaming
      clientData.isStreaming = false;
      if (clientData?.streamingTimeout) {
        clearTimeout(clientData.streamingTimeout);
        clientData.streamingTimeout = null;
      }
      
      // Legacy interval cleanup
      if (clientData?.screenInterval) {
        clearInterval(clientData.screenInterval);
        clientData.screenInterval = null;
      }
      
      const clientTimers = this.activeTimers.get(socketId);
      if (clientTimers) {
        clientTimers.forEach(timerId => clearTimeout(timerId));
        this.activeTimers.delete(socketId);
      }
      
      const clientChunkTimers = this.chunkTimers.get(socketId);
      if (clientChunkTimers) {
        clientChunkTimers.forEach(timerId => clearTimeout(timerId));
        this.chunkTimers.delete(socketId);
      }
      
      if (clientData?.tileManager) {
        clientData.tileManager.clearMemory();
        clientData.tileManager.cleanup();
        clientData.tileManager.reset();
      }
    } catch (error) {
      console.error(`Error cleaning up ${socketId}:`, error.message);
    }
  }

  getStreamingConfig() {
    return REMOTE_CONFIG.streaming;
  }

  getWebRTCConfig() {
    return REMOTE_CONFIG.webrtc;
  }

  removeClient(socketId) {
    const clientData = this.activeClients.get(socketId);
    if (clientData) {
      this.cleanupClientResources(socketId, clientData);
      this.activeClients.delete(socketId);
    }
  }

  getChunkTimers(socketId) {
    if (!this.chunkTimers.has(socketId)) {
      this.chunkTimers.set(socketId, new Set());
    }
    return this.chunkTimers.get(socketId);
  }

  cleanupAll() {
    this.stopResourceMonitoring();
    for (const [socketId, clientData] of this.activeClients.entries()) {
      this.cleanupClientResources(socketId, clientData);
    }
    this.activeClients.clear();
    this.activeTimers.clear();
    this.chunkTimers.clear();
  }
}
