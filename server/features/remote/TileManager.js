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
    this.dpiScale = 1;
    this.captureWidth = 0;
    this.captureHeight = 0;

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
      
      // Detect DPI scale once at initialization
      this.detectDpiScale();
      
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

      console.log(`🖥️ TileManager: ${width}x${height} (DPI ${this.dpiScale}x) -> ${this.totalTiles} tiles`);
    } catch (error) {
      console.error("Screen dimensions error:", error);
      this.screenWidth = 1920;
      this.screenHeight = 1080;
      this.dpiScale = 1;
      this.captureWidth = 1920;
      this.captureHeight = 1080;
      this.scaledWidth = 1728;
      this.scaledHeight = 972;
      this.tileSize = 120;
      this.tilesPerRow = Math.ceil(this.scaledWidth / this.tileSize);
      this.tilesPerColumn = Math.ceil(this.scaledHeight / this.tileSize);
      this.totalTiles = this.tilesPerRow * this.tilesPerColumn;
    }
  }

  detectDpiScale() {
    if (process.platform === "darwin") {
      // macOS: Detect Retina scale by capturing 1x1
      const testCapture = this.robot.screen.capture(0, 0, 1, 1);
      this.dpiScale = testCapture.byteWidth / testCapture.bytesPerPixel;
    } else {
      // Windows/Linux: Detect by capturing at 2x logical and comparing
      const testWidth = Math.min(this.screenWidth * 2, 4096);
      const testHeight = Math.min(this.screenHeight * 2, 4096);
      const testCapture = this.robot.screen.capture(0, 0, testWidth, testHeight);
      const actualWidth = testCapture.byteWidth / testCapture.bytesPerPixel;
      
      if (actualWidth > this.screenWidth) {
        this.dpiScale = actualWidth / this.screenWidth;
      } else {
        this.dpiScale = 1;
      }
    }
    
    this.captureWidth = Math.floor(this.screenWidth * this.dpiScale);
    this.captureHeight = Math.floor(this.screenHeight * this.dpiScale);
  }

  async captureFullScreen() {
    // Use cached DPI scale - no need to detect every capture
    const bitmap = this.robot.screen.capture(0, 0, this.captureWidth, this.captureHeight);
    const imageBuffer = Buffer.from(bitmap.image);

    // BGRA -> RGBA optimized using Uint32Array (4x faster than byte loop)
    const uint32View = new Uint32Array(imageBuffer.buffer, imageBuffer.byteOffset, imageBuffer.length >> 2);
    for (let i = 0; i < uint32View.length; i++) {
      const pixel = uint32View[i];
      // Swap R and B: BGRA (0xAARRGGBB in LE) -> RGBA (0xAABBGGRR in LE)
      uint32View[i] = (pixel & 0xFF00FF00) | ((pixel & 0x00FF0000) >> 16) | ((pixel & 0x000000FF) << 16);
    }

    const actualWidth = bitmap.byteWidth / bitmap.bytesPerPixel;
    const actualHeight = bitmap.height;
    let finalBuffer = imageBuffer;
    let finalWidth = actualWidth;
    let finalHeight = actualHeight;

    // Resize to logical size for performance (skip if already at logical size)
    if (this.dpiScale > 1 || this.scaleFactor < 1.0) {
      const targetWidth = Math.floor(this.screenWidth * this.scaleFactor);
      const targetHeight = Math.floor(this.screenHeight * this.scaleFactor);

      const scaledBuffer = await sharp(imageBuffer, {
        raw: { width: actualWidth, height: actualHeight, channels: bitmap.bytesPerPixel }
      })
        .resize(targetWidth, targetHeight, { kernel: sharp.kernel.nearest, fit: "fill" })
        .raw()
        .toBuffer();

      finalBuffer = scaledBuffer;
      finalWidth = targetWidth;
      finalHeight = targetHeight;
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
    const result = await this.detectChangedTilesWithHashes();
    return result.tiles;
  }

  async detectChangedTilesWithHashes() {
    if (this.isProcessing) return { tiles: [], currentHashes: Array.from(this.lastTileChecksums.values()) };
    this.isProcessing = true;

    try {
      const screenData = await this.getSharedScreenCapture();
      const changedTiles = [];
      const changedTileIndices = [];
      const currentTileHashes = new Map();
      this.frameCount++;

      // Calculate hashes directly without extracting tiles (lazy extraction)
      for (let i = 0; i < this.totalTiles; i++) {
        const checksum = this.calculateTileChecksumDirect(screenData, i);
        currentTileHashes.set(i, checksum);
      }

      const currentHashes = Array.from(currentTileHashes.values());

      // First frame - extract and send all tiles
      if (this.lastTileChecksums.size === 0) {
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          this.lastTileChecksums.set(i, currentTileHashes.get(i));
          tilePromises.push(this.processTileAsync(screenData, i));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
        return { tiles: changedTiles, currentHashes };
      }

      // Find changed tiles by comparing hashes
      for (let i = 0; i < this.totalTiles; i++) {
        const checksum = currentTileHashes.get(i);
        const lastChecksum = this.lastTileChecksums.get(i);
        if (checksum !== lastChecksum) {
          changedTileIndices.push(i);
          this.lastTileChecksums.set(i, checksum);
        }
      }

      const changePercentage = changedTileIndices.length / this.totalTiles;

      if (changePercentage > this.changeThreshold) {
        // Full refresh - extract all tiles
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          tilePromises.push(this.processTileAsync(screenData, i));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results.map(t => ({ ...t, fullRefresh: true })));
      } else if (changedTileIndices.length > 0) {
        // Only extract changed tiles (lazy extraction benefit)
        const tilePromises = changedTileIndices.map(i => 
          this.processTileAsync(screenData, i)
        );
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
      }

      return { tiles: changedTiles, currentHashes };
    } finally {
      this.isProcessing = false;
    }
  }

  async processTileAsync(screenData, tileIndex, cachedTileData = null) {
    const tileData = cachedTileData || this.extractTile(screenData, tileIndex);
    const checksum = this.calculateTileChecksum(tileData.buffer);
    this.lastTileChecksums.set(tileIndex, checksum);

    const imageBuffer = await this.compressTileImage(tileData.buffer, tileData.width, tileData.height);
    const { row, col } = this.getTilePosition(tileIndex);

    return {
      type: "tile-update",
      tileIndex,
      x: col * this.tileSize,
      y: row * this.tileSize,
      width: tileData.width,
      height: tileData.height,
      imageBuffer, // Binary buffer instead of base64
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

  // Calculate checksum directly from screenData without extracting tile
  calculateTileChecksumDirect(screenData, tileIndex) {
    const { row, col } = this.getTilePosition(tileIndex);
    const startX = col * this.tileSize;
    const startY = row * this.tileSize;
    const endX = Math.min(startX + this.tileSize, screenData.width);
    const endY = Math.min(startY + this.tileSize, screenData.height);
    const tileWidth = endX - startX;
    const tileHeight = endY - startY;
    const channels = screenData.channels;
    const screenRowBytes = screenData.width * channels;

    let sum = 0;
    const sampleStep = 16; // Sample every 16 pixels for speed

    for (let y = 0; y < tileHeight; y += 4) {
      const rowOffset = (startY + y) * screenRowBytes + startX * channels;
      for (let x = 0; x < tileWidth; x += sampleStep) {
        const offset = rowOffset + x * channels;
        sum += screenData.buffer[offset] || 0;
        sum ^= screenData.buffer[offset + 1] || 0;
        sum += (screenData.buffer[offset + 2] || 0) << 1;
        sum ^= (screenData.buffer[offset + 3] || 0) << 2;
      }
    }
    return sum >>> 0;
  }

  getTilePosition(tileIndex) {
    return {
      row: Math.floor(tileIndex / this.tilesPerRow),
      col: tileIndex % this.tilesPerRow
    };
  }

  extractTile(screenData, tileIndex) {
    const { row, col } = this.getTilePosition(tileIndex);
    const startX = col * this.tileSize;
    const startY = row * this.tileSize;
    const endX = Math.min(startX + this.tileSize, screenData.width);
    const endY = Math.min(startY + this.tileSize, screenData.height);
    const tileWidth = endX - startX;
    const tileHeight = endY - startY;
    const channels = screenData.channels;
    const rowBytes = tileWidth * channels;

    const tileBuffer = Buffer.alloc(tileWidth * tileHeight * channels);

    // Copy row by row using Buffer.copy (much faster than pixel loop)
    for (let y = 0; y < tileHeight; y++) {
      const srcOffset = ((startY + y) * screenData.width + startX) * channels;
      const dstOffset = y * rowBytes;
      screenData.buffer.copy(tileBuffer, dstOffset, srcOffset, srcOffset + rowBytes);
    }

    return { buffer: tileBuffer, width: tileWidth, height: tileHeight, channels, tileIndex, x: startX, y: startY };
  }

  async compressTileImage(buffer, width, height) {
    // Return raw Buffer for binary transfer (no base64 overhead)
    return await sharp(buffer, { raw: { width, height, channels: 4 } })
      .webp({ quality: 85, effort: 2, smartSubsample: true })
      .toBuffer();
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

      // Calculate hashes directly without extracting tiles (lazy extraction)
      const currentTileHashes = new Map();
      for (let i = 0; i < this.totalTiles; i++) {
        const checksum = this.calculateTileChecksumDirect(screenData, i);
        currentTileHashes.set(i, checksum);
        this.lastTileChecksums.set(i, checksum);
      }

      if (!clientTileHashes || clientTileHashes.length === 0) {
        // First request - extract all tiles
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          tilePromises.push(this.processTileAsync(screenData, i));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
        return { tiles: changedTiles, currentHashes: Array.from(currentTileHashes.values()) };
      }

      // Find changed tiles by comparing hashes
      for (let i = 0; i < this.totalTiles; i++) {
        if (clientTileHashes[i] !== currentTileHashes.get(i)) {
          changedTileIndices.push(i);
        }
      }

      const changePercentage = changedTileIndices.length / this.totalTiles;

      if (changePercentage > this.changeThreshold) {
        // Full refresh - extract all tiles
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          tilePromises.push(this.processTileAsync(screenData, i));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results.map(t => ({ ...t, fullRefresh: true })));
      } else if (changedTileIndices.length > 0) {
        // Only extract changed tiles (lazy extraction benefit)
        const tilePromises = changedTileIndices.map(i => 
          this.processTileAsync(screenData, i)
        );
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
      }

      return { tiles: changedTiles, currentHashes: Array.from(currentTileHashes.values()), changedIndices: changedTileIndices };
    } finally {
      this.isProcessing = false;
    }
  }

  clearMemory() {
    this.sharedScreenCache = null;
    this.lastCaptureTime = 0;
    this.lastTileChecksums.clear();
  }

  reset() {
    this.lastTileChecksums.clear();
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
