// TileManager for Remote Desktop Screen Capture
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TileManager {
  constructor(robot) {
    this.robot = robot;
    this.tileSize = 100;
    this.lastTileChecksums = new Map();
    this.lastTileBuffers = new Map();
    this.screenWidth = 0;
    this.screenHeight = 0;
    this.tilesPerRow = 0;
    this.tilesPerColumn = 0;
    this.totalTiles = 0;
    this.frameCount = 0;
    this.tempDir = path.join(__dirname, "../../temp");
    this.compressionQuality = 1;
    this.changeThreshold = 1;
    this.scaleFactor = 0.99;
    this.scaledWidth = 0;
    this.scaledHeight = 0;
    this.isProcessing = false;
    this.sharedScreenCache = null;
    this.lastCaptureTime = 0;
    this.CACHE_TTL = 100;

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    this.initializeScreenDimensions();
  }

  initializeScreenDimensions() {
    try {
      const { width, height } = this.robot.getScreenSize();
      this.screenWidth = width;
      this.screenHeight = height;
      this.scaledWidth = Math.floor(width * this.scaleFactor);
      this.scaledHeight = Math.floor(height * this.scaleFactor);
      this.tilesPerRow = Math.ceil(this.scaledWidth / this.tileSize);
      this.tilesPerColumn = Math.ceil(this.scaledHeight / this.tileSize);
      this.totalTiles = this.tilesPerRow * this.tilesPerColumn;

      const MAX_TILES = 100;
      if (this.totalTiles > MAX_TILES) {
        const optimalTileSize = Math.ceil(Math.sqrt((this.scaledWidth * this.scaledHeight) / MAX_TILES));
        this.tileSize = Math.max(optimalTileSize, 120);
        this.tilesPerRow = Math.ceil(this.scaledWidth / this.tileSize);
        this.tilesPerColumn = Math.ceil(this.scaledHeight / this.tileSize);
        this.totalTiles = this.tilesPerRow * this.tilesPerColumn;
      }

      console.log(`🖥️ TileManager: ${width}x${height} -> ${this.totalTiles} tiles`);
    } catch (error) {
      console.error("Screen dimensions error:", error);
      this.screenWidth = 1920;
      this.screenHeight = 1080;
      this.scaledWidth = 1728;
      this.scaledHeight = 972;
      this.tileSize = 120;
      this.tilesPerRow = Math.ceil(this.scaledWidth / this.tileSize);
      this.tilesPerColumn = Math.ceil(this.scaledHeight / this.tileSize);
      this.totalTiles = this.tilesPerRow * this.tilesPerColumn;
    }
  }

  async captureFullScreen() {
    const bitmap = this.robot.screen.capture();
    const imageBuffer = Buffer.from(bitmap.image);

    // BGRA -> RGBA
    for (let i = 0; i < imageBuffer.length; i += 4) {
      const b = imageBuffer[i];
      const r = imageBuffer[i + 2];
      imageBuffer[i] = r;
      imageBuffer[i + 2] = b;
    }

    const actualWidth = bitmap.byteWidth / bitmap.bytesPerPixel;
    let finalBuffer = imageBuffer;
    let finalWidth = actualWidth;
    let finalHeight = bitmap.height;

    if (this.scaleFactor < 1.0) {
      const targetWidth = Math.floor(actualWidth * this.scaleFactor);
      const targetHeight = Math.floor(bitmap.height * this.scaleFactor);

      const scaledBuffer = await sharp(imageBuffer, {
        raw: { width: actualWidth, height: bitmap.height, channels: bitmap.bytesPerPixel }
      })
        .resize(targetWidth, targetHeight, { kernel: sharp.kernel.lanczos3, fit: "fill" })
        .raw()
        .toBuffer();

      finalBuffer = scaledBuffer;
      finalWidth = targetWidth;
      finalHeight = targetHeight;
      this.scaledWidth = targetWidth;
      this.scaledHeight = targetHeight;
      this.tilesPerRow = Math.ceil(targetWidth / this.tileSize);
      this.tilesPerColumn = Math.ceil(targetHeight / this.tileSize);
      this.totalTiles = this.tilesPerRow * this.tilesPerColumn;
    }

    return { buffer: finalBuffer, width: finalWidth, height: finalHeight, channels: bitmap.bytesPerPixel };
  }

  async getSharedScreenCapture() {
    const now = Date.now();
    if (this.sharedScreenCache && (now - this.lastCaptureTime) < this.CACHE_TTL) {
      return this.sharedScreenCache;
    }
    this.sharedScreenCache = await this.captureFullScreen();
    this.lastCaptureTime = now;
    return this.sharedScreenCache;
  }

  clearScreenCache() {
    // Intentionally empty
  }

  async detectChangedTiles() {
    if (this.isProcessing) return [];
    this.isProcessing = true;

    try {
      const screenData = await this.getSharedScreenCapture();
      const changedTiles = [];
      const changedTileIndices = [];
      this.frameCount++;

      if (this.lastTileChecksums.size === 0) {
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          tilePromises.push(this.processTileAsync(screenData, i, true));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
        return changedTiles;
      }

      for (let i = 0; i < this.totalTiles; i++) {
        const tileData = await this.extractTile(screenData, i);
        const checksum = this.calculateTileChecksum(tileData.buffer);
        const lastChecksum = this.lastTileChecksums.get(i);
        if (checksum !== lastChecksum) {
          changedTileIndices.push(i);
          this.lastTileChecksums.set(i, checksum);
        }
      }

      const changePercentage = changedTileIndices.length / this.totalTiles;

      if (changePercentage > this.changeThreshold) {
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          tilePromises.push(this.processTileAsync(screenData, i, true));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results.map(t => ({ ...t, fullRefresh: true })));
      } else if (changedTileIndices.length > 0) {
        const tilePromises = changedTileIndices.map(i => this.processTileAsync(screenData, i, false));
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
      }

      return changedTiles;
    } finally {
      this.isProcessing = false;
    }
  }

  async processTileAsync(screenData, tileIndex) {
    const tileData = await this.extractTile(screenData, tileIndex);
    const checksum = this.calculateTileChecksum(tileData.buffer);
    this.lastTileChecksums.set(tileIndex, checksum);
    this.lastTileBuffers.set(tileIndex, tileData.buffer);

    const compressedImage = await this.compressTileImage(tileData.buffer, tileData.width, tileData.height);
    const { row, col } = this.getTilePosition(tileIndex);

    return {
      type: "tile-update",
      tileIndex,
      x: col * this.tileSize,
      y: row * this.tileSize,
      width: tileData.width,
      height: tileData.height,
      imageBase64: compressedImage,
      size: Math.round(compressedImage.length * 0.75 / 1024),
      timestamp: Date.now(),
      frameCount: this.frameCount
    };
  }

  calculateTileChecksum(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 64) {
      sum += buffer[i] || 0;
      sum ^= buffer[i + 1] || 0;
      sum += (buffer[i + 2] || 0) << 1;
      sum ^= (buffer[i + 3] || 0) << 2;
    }
    return sum >>> 0;
  }

  getTilePosition(tileIndex) {
    return {
      row: Math.floor(tileIndex / this.tilesPerRow),
      col: tileIndex % this.tilesPerRow
    };
  }

  async extractTile(screenData, tileIndex) {
    const { row, col } = this.getTilePosition(tileIndex);
    const startX = col * this.tileSize;
    const startY = row * this.tileSize;
    const endX = Math.min(startX + this.tileSize, screenData.width);
    const endY = Math.min(startY + this.tileSize, screenData.height);
    const tileWidth = endX - startX;
    const tileHeight = endY - startY;

    const tileBuffer = Buffer.alloc(tileWidth * tileHeight * screenData.channels);

    for (let y = 0; y < tileHeight; y++) {
      for (let x = 0; x < tileWidth; x++) {
        const srcOffset = ((startY + y) * screenData.width + (startX + x)) * screenData.channels;
        const dstOffset = (y * tileWidth + x) * screenData.channels;
        for (let c = 0; c < screenData.channels; c++) {
          tileBuffer[dstOffset + c] = screenData.buffer[srcOffset + c];
        }
      }
    }

    return { buffer: tileBuffer, width: tileWidth, height: tileHeight, channels: screenData.channels, tileIndex, x: startX, y: startY };
  }

  async compressTileImage(buffer, width, height) {
    const compressedBuffer = await sharp(buffer, { raw: { width, height, channels: 4 } })
      .webp({ quality: 85, effort: 2, smartSubsample: true })
      .toBuffer();

    return `data:image/webp;base64,${compressedBuffer.toString("base64")}`;
  }

  async getScreenDimensions() {
    try {
      const screenData = await this.captureFullScreen();
      this.scaledWidth = screenData.width;
      this.scaledHeight = screenData.height;
      this.tilesPerRow = Math.ceil(screenData.width / this.tileSize);
      this.tilesPerColumn = Math.ceil(screenData.height / this.tileSize);
      this.totalTiles = this.tilesPerRow * this.tilesPerColumn;
    } catch (error) {
      console.error("Error getting dimensions:", error);
    }

    return {
      width: this.scaledWidth,
      height: this.scaledHeight,
      tileWidth: this.tileSize,
      tileHeight: this.tileSize,
      tileCount: this.totalTiles,
      scaleFactor: this.scaleFactor,
      originalWidth: this.screenWidth,
      originalHeight: this.screenHeight
    };
  }

  async compareClientTileHashes(clientTileHashes) {
    if (this.isProcessing) return { tiles: [], currentHashes: [], changedIndices: [] };
    this.isProcessing = true;

    try {
      const screenData = await this.getSharedScreenCapture();
      const changedTiles = [];
      const changedTileIndices = [];
      this.frameCount++;

      const currentTileHashes = new Map();
      for (let i = 0; i < this.totalTiles; i++) {
        const tileData = await this.extractTile(screenData, i);
        const checksum = this.calculateTileChecksum(tileData.buffer);
        currentTileHashes.set(i, checksum);
        this.lastTileChecksums.set(i, checksum);
      }

      if (!clientTileHashes || clientTileHashes.length === 0) {
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          tilePromises.push(this.processTileAsync(screenData, i, true));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
        return { tiles: changedTiles, currentHashes: Array.from(currentTileHashes.values()) };
      }

      for (let i = 0; i < this.totalTiles; i++) {
        if (clientTileHashes[i] !== currentTileHashes.get(i)) {
          changedTileIndices.push(i);
        }
      }

      const changePercentage = changedTileIndices.length / this.totalTiles;

      if (changePercentage > this.changeThreshold) {
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          tilePromises.push(this.processTileAsync(screenData, i, true));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results.map(t => ({ ...t, fullRefresh: true })));
      } else if (changedTileIndices.length > 0) {
        const tilePromises = changedTileIndices.map(i => this.processTileAsync(screenData, i, false));
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
      }

      return { tiles: changedTiles, currentHashes: Array.from(currentTileHashes.values()), changedIndices: changedTileIndices };
    } finally {
      this.isProcessing = false;
    }
  }

  reset() {
    this.lastTileChecksums.clear();
    this.lastTileBuffers.clear();
    this.frameCount = 0;
  }

  cleanup() {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        files.forEach(file => fs.unlinkSync(path.join(this.tempDir, file)));
      }
    } catch (error) {
      console.warn("Cleanup error:", error);
    }
  }
}
