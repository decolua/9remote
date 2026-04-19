// TileManager for Remote Desktop Screen Capture
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { REMOTE_CONFIG } from "./REMOTE_CONFIG.js";
import * as capture from "./adapters/captureAdapter.js";
import { encodeJpeg } from "./adapters/encoderAdapter.js";
import { FrameMetrics } from "./metrics.js";
import { remoteLog } from "./utils/remoteLog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TileManager {
  constructor(robot) {
    this.robot = robot;
    this.metrics = new FrameMetrics();
    this.tileSize = REMOTE_CONFIG.pipeline.tileSize;
    this.lastTileChecksums = new Map();
    this.screenWidth = 0;
    this.screenHeight = 0;
    this.tilesPerRow = 0;
    this.tilesPerColumn = 0;
    this.totalTiles = 0;
    this.frameCount = 0;
    this.tempDir = path.join(__dirname, "../../temp");
    this.changeThreshold = 1;
    this.scaledWidth = 0;
    this.scaledHeight = 0;
    this.isProcessing = false;
    this.sharedScreenCache = null;
    this.lastCaptureTime = 0;
    this.CACHE_TTL = 100;
    this.dpiScale = 1;
    this.captureWidth = 0;
    this.captureHeight = 0;
    // Output scale applied post-capture (downscale before tiling). 1 = native.
    this.scaleFactor = REMOTE_CONFIG.pipeline.outputScale || 1;
    this.compressionQuality = REMOTE_CONFIG.pipeline.jpegQuality;
    // Focus region: Set<tileIndex> of active tiles, null = all tiles (full screen)
    this.activeTileSet = null;
    // Focus effectiveness stats — aggregated per N frames
    this.focusStats = { frames: 0, scanned: 0, changed: 0, bytes: 0 };

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    capture.initCapture(robot);
    this.initializeScreenDimensions();
  }

  initializeScreenDimensions() {
    try {
      const { width, height } = this.robot.getScreenSize();
      this.screenWidth = width;
      this.screenHeight = height;

      // Detect DPI scale once at initialization
      this.detectDpiScale();

      // Final buffer size after capture + outputScale downscale.
      // captureWidth/Height = physical pixels; scaleFactor = outputScale.
      this.scaledWidth = Math.max(1, Math.floor(this.captureWidth * this.scaleFactor));
      this.scaledHeight = Math.max(1, Math.floor(this.captureHeight * this.scaleFactor));
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

      // console.log(`🖥️ [TileManager Init] Logical: ${width}x${height} | DPI Scale: ${this.dpiScale}x | Capture: ${this.captureWidth}x${this.captureHeight} | Scaled: ${this.scaledWidth}x${this.scaledHeight} | Tiles: ${this.totalTiles}`);
    } catch (error) {
      remoteLog.error("Screen dimensions error:", error);
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
      // macOS: capture full screen to detect actual pixel density
      const testCapture = this.robot.screen.capture(0, 0, this.screenWidth, this.screenHeight);
      const actualWidth = testCapture.byteWidth / testCapture.bytesPerPixel;
      const scale = actualWidth / this.screenWidth;

      // Only accept 1x or 2x (Retina)
      if (scale >= 1.9 && scale <= 2.1) {
        this.dpiScale = 2;
      } else {
        this.dpiScale = 1;
      }
    } else if (process.platform === "win32") {
      this.dpiScale = this._detectDpiScaleWin32();
    } else {
      // Linux (X11): always logical pixels
      this.dpiScale = 1;
    }

    this.captureWidth = Math.floor(this.screenWidth * this.dpiScale);
    this.captureHeight = Math.floor(this.screenHeight * this.dpiScale);
  }

  _detectDpiScaleWin32() {
    remoteLog.dpi(`🔍 [DPI Detection] screenWidth from robot: ${this.screenWidth}x${this.screenHeight}`);

    // Strategy 1: Read AppliedDPI from WindowMetrics registry (Windows 10/11)
    // 96 DPI = 100%, 120 = 125%, 144 = 150%, 192 = 200%
    try {
      const out = execSync(
        "powershell -NonInteractive -NoProfile -WindowStyle Hidden -command \"try{Get-ItemPropertyValue 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name AppliedDPI}catch{0}\"",
        { encoding: "utf8", windowsHide: true }
      ).trim();
      const dpi = Number(out);
      remoteLog.dpi(`🔍 [DPI Detection] Strategy 1 (Registry AppliedDPI): ${dpi} DPI`);
      if (dpi >= 96) {
        const scale = dpi / 96;
        remoteLog.dpi(`✅ [DPI Detection] Using registry scale: ${scale}x (${dpi}/96)`);
        return scale;
      }
    } catch (err) {
      remoteLog.dpi(`❌ [DPI Detection] Strategy 1 failed: ${err.message}`);
    }

    // Strategy 2: Query physical resolution via WMI and compare with logical
    try {
      const out = execSync(
        "powershell -NonInteractive -NoProfile -WindowStyle Hidden -command \"(Get-WmiObject -Class Win32_VideoController | Select-Object -First 1).CurrentHorizontalResolution\"",
        { encoding: "utf8", windowsHide: true }
      ).trim();
      const physW = Number(out);
      remoteLog.dpi(`🔍 [DPI Detection] Strategy 2 (WMI): physical width = ${physW}px`);
      if (physW > 0 && physW > this.screenWidth) {
        const scale = physW / this.screenWidth;
        remoteLog.dpi(`✅ [DPI Detection] Using WMI scale: ${scale}x (${physW}/${this.screenWidth})`);
        return scale;
      }
    } catch (err) {
      remoteLog.dpi(`❌ [DPI Detection] Strategy 2 failed: ${err.message}`);
    }

    // Strategy 3: Query physical resolution via EnumDisplaySettings and compare with logical
    try {
      const out = execSync(
        "powershell -NonInteractive -NoProfile -WindowStyle Hidden -command \"Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Disp{[DllImport(\\\"user32\\\")]public static extern bool EnumDisplaySettings(string d,int m,ref DEVMODE dm);[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Ansi)]public struct DEVMODE{[MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)]public string dmDeviceName;public short dmSpecVersion,dmDriverVersion,dmSize,dmDriverExtra;public int dmFields;public int dmPositionX,dmPositionY,dmDisplayOrientation,dmDisplayFixedOutput;public short dmColor,dmDuplex,dmYResolution,dmTTOption,dmCollate;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)]public string dmFormName;public short dmLogPixels;public int dmBitsPerPel,dmPelsWidth,dmPelsHeight,dmDisplayFlags,dmDisplayFrequency;}}'; $dm=New-Object Disp+DEVMODE; $dm.dmSize=[System.Runtime.InteropServices.Marshal]::SizeOf($dm); [Disp]::EnumDisplaySettings($null,-1,[ref]$dm) | Out-Null; Write-Output $dm.dmPelsWidth\"",
        { encoding: "utf8", windowsHide: true }
      ).trim();
      const physW = Number(out);
      remoteLog.dpi(`🔍 [DPI Detection] Strategy 3 (EnumDisplaySettings): physical width = ${physW}px`);
      if (physW > 0 && physW > this.screenWidth) {
        const scale = physW / this.screenWidth;
        remoteLog.dpi(`✅ [DPI Detection] Using EnumDisplaySettings scale: ${scale}x (${physW}/${this.screenWidth})`);
        return scale;
      }
    } catch (err) {
      remoteLog.dpi(`❌ [DPI Detection] Strategy 3 failed: ${err.message}`);
    }

    remoteLog.dpi(`⚠️ [DPI Detection] All strategies failed, fallback to 1x`);
    return 1;
  }

  async captureFullScreen() {
    // Capture via adapter — returns native format (BGRA or RGBA).
    const result = await capture.captureFull();

    // Optional downscale — sharp resize on raw buffer, preserves channel order
    // (no BGRA↔RGBA swap since sharp operates per-channel). Done once per frame
    // so all downstream tiles/checksums/focus operate in scaled space.
    const scale = REMOTE_CONFIG.pipeline.outputScale;
    if (scale && scale > 0 && scale < 1) {
      const targetW = Math.max(1, Math.floor(result.width * scale));
      const targetH = Math.max(1, Math.floor(result.height * scale));
      const scaled = await sharp(result.buffer, {
        raw: { width: result.width, height: result.height, channels: result.channels }
      })
        .resize(targetW, targetH, { kernel: "lanczos3", fastShrinkOnLoad: false })
        .raw()
        .toBuffer();
      return { buffer: scaled, width: targetW, height: targetH, channels: result.channels };
    }

    return {
      buffer: result.buffer,
      width: result.width,
      height: result.height,
      channels: result.channels
    };
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

    // Metrics: stage timers (performance.now() returns 0 when disabled)
    const tStart = this.metrics.now();
    let tCaptureEnd = tStart, tChecksumEnd = tStart;

    try {
      const screenData = await this.getSharedScreenCapture();
      tCaptureEnd = this.metrics.now();

      const changedTiles = [];
      const changedTileIndices = [];
      const currentTileHashes = new Map();
      this.frameCount++;

      // Focus-based streaming: skip tiles outside client viewport+padding
      const activeSet = this.activeTileSet;

      // Calculate hashes directly without extracting tiles (lazy extraction)
      for (let i = 0; i < this.totalTiles; i++) {
        if (activeSet && !activeSet.has(i)) continue;
        const checksum = this.calculateTileChecksumDirect(screenData, i);
        currentTileHashes.set(i, checksum);
      }
      tChecksumEnd = this.metrics.now();

      const currentHashes = Array.from(currentTileHashes.values());

      // First frame - extract and send all tiles (within focus set)
      if (this.lastTileChecksums.size === 0) {
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          if (activeSet && !activeSet.has(i)) continue;
          this.lastTileChecksums.set(i, currentTileHashes.get(i));
          tilePromises.push(this.processTileAsync(screenData, i));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
        this._recordFrame(tStart, tCaptureEnd, tChecksumEnd, changedTiles, screenData);
        return { tiles: changedTiles, currentHashes };
      }

      // Find changed tiles by comparing hashes
      for (let i = 0; i < this.totalTiles; i++) {
        if (activeSet && !activeSet.has(i)) continue;
        const checksum = currentTileHashes.get(i);
        const lastChecksum = this.lastTileChecksums.get(i);
        if (checksum !== lastChecksum) {
          changedTileIndices.push(i);
          this.lastTileChecksums.set(i, checksum);
        }
      }

      const changePercentage = changedTileIndices.length / this.totalTiles;

      if (changePercentage > this.changeThreshold) {
        // Full refresh - extract all tiles (within focus set)
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          if (activeSet && !activeSet.has(i)) continue;
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

      this._recordFrame(tStart, tCaptureEnd, tChecksumEnd, changedTiles, screenData);

      // if (changedTiles.length > 0) {
      //   const sizes = changedTiles.map(t => t.imageBuffer.length);
      //   const total = sizes.reduce((a, b) => a + b, 0);
      //   const avg = total / sizes.length;
      //   const min = Math.min(...sizes);
      //   const max = Math.max(...sizes);
      //   console.log(`[Stream] ${changedTiles.length} tiles | avg ${(avg / 1024).toFixed(1)}KB | min ${(min / 1024).toFixed(1)}KB | max ${(max / 1024).toFixed(1)}KB | total ${(total / 1024).toFixed(1)}KB`);
      // }

      return { tiles: changedTiles, currentHashes };
    } finally {
      this.isProcessing = false;
    }
  }

  async processTileAsync(screenData, tileIndex, cachedTileData = null) {
    const tileData = cachedTileData || this.extractTile(screenData, tileIndex);
    // Don't overwrite checksum here - detectChangedTilesWithHashes already updated it correctly
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
    // Hexagonal pattern: even rows start at 0, odd rows start at 8.
    // Covers pixels missed by a square grid while keeping checksum stable.

    for (let y = 0; y < tileHeight; y += 4) {
      const offsetX = ((y >> 2) & 1) * 8;
      const rowOffset = (startY + y) * screenRowBytes + startX * channels;
      for (let x = offsetX; x < tileWidth; x += sampleStep) {
        const offset = rowOffset + x * channels;
        sum += screenData.buffer[offset];
        sum ^= screenData.buffer[offset + 1];
        sum += screenData.buffer[offset + 2] << 1;
        sum ^= screenData.buffer[offset + 3] << 2;
      }
    }
    return sum >>> 0;
  }

  // Set focus region from client viewport (canvas-space pixels).
  // rect={x,y,w,h} → active tile set with configured padding. null → full screen.
  // Newly exposed tiles have their checksum cleared so they re-send on next frame.
  setFocusRect(rect) {
    if (!rect) {
      this.activeTileSet = null;
      return;
    }
    const pad = REMOTE_CONFIG.focus.paddingTiles;
    const col0 = Math.max(0, Math.floor(rect.x / this.tileSize) - pad);
    const row0 = Math.max(0, Math.floor(rect.y / this.tileSize) - pad);
    const col1 = Math.min(this.tilesPerRow - 1, Math.floor((rect.x + rect.w) / this.tileSize) + pad);
    const row1 = Math.min(this.tilesPerColumn - 1, Math.floor((rect.y + rect.h) / this.tileSize) + pad);

    const nextSet = new Set();
    for (let r = row0; r <= row1; r++) {
      for (let c = col0; c <= col1; c++) {
        nextSet.add(r * this.tilesPerRow + c);
      }
    }
    // Force re-send for tiles newly entering focus (pan to new area)
    const prevSet = this.activeTileSet;
    if (prevSet) {
      for (const idx of nextSet) {
        if (!prevSet.has(idx)) this.lastTileChecksums.delete(idx);
      }
    }
    this.activeTileSet = nextSet;
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
    // Delegated to encoderAdapter (sharp | jpeg-turbo) based on REMOTE_CONFIG.pipeline
    return encodeJpeg(buffer, width, height, 4);
  }

  _recordFrame(tStart, tCaptureEnd, tChecksumEnd, tiles, screenData) {
    this._recordFocusFrame(tiles);
    if (!this.metrics.cfg.metrics) return;
    const tEnd = this.metrics.now();
    const tileBytes = tiles.map(t => t.imageBuffer?.length || 0);
    const rawBytes = screenData ? (screenData.width * screenData.height * screenData.channels) : 0;
    this.metrics.record({
      capture: tCaptureEnd - tStart,
      checksum: tChecksumEnd - tCaptureEnd,
      encode: tEnd - tChecksumEnd,
      total: tEnd - tStart,
      changedTiles: tiles.length,
      totalTiles: this.totalTiles,
      tileBytes,
      rawBytes
    });
  }

  // Aggregate focus effectiveness and log every N frames
  _recordFocusFrame(tiles) {
    const s = this.focusStats;
    s.frames++;
    s.scanned += this.activeTileSet ? this.activeTileSet.size : this.totalTiles;
    s.changed += tiles.length;
    for (const t of tiles) s.bytes += t.imageBuffer?.length || 0;

    if (s.frames < REMOTE_CONFIG.logging.focusEveryFrames) return;
    const avgScanned = (s.scanned / s.frames).toFixed(0);
    const avgChanged = (s.changed / s.frames).toFixed(1);
    const avgKB = (s.bytes / s.frames / 1024).toFixed(1);
    const savedPct = this.totalTiles ? ((1 - avgScanned / this.totalTiles) * 100).toFixed(0) : 0;
    const mode = this.activeTileSet ? "focus" : "full";
    remoteLog.focus(`🎯 [Focus/${mode}] ${s.frames}f | scan ${avgScanned}/${this.totalTiles} tiles (saved ${savedPct}%) | changed ${avgChanged}/f | data ${avgKB}KB/f`);
    this.focusStats = { frames: 0, scanned: 0, changed: 0, bytes: 0 };
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
      remoteLog.error("Error getting dimensions:", error);
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

      // Focus-based streaming: skip tiles outside client viewport+padding
      const activeSet = this.activeTileSet;

      // Calculate hashes directly without extracting tiles (lazy extraction)
      const currentTileHashes = new Map();
      for (let i = 0; i < this.totalTiles; i++) {
        if (activeSet && !activeSet.has(i)) continue;
        const checksum = this.calculateTileChecksumDirect(screenData, i);
        currentTileHashes.set(i, checksum);
        this.lastTileChecksums.set(i, checksum);
      }

      if (!clientTileHashes || clientTileHashes.length === 0) {
        // First request - extract all tiles (within focus set)
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          if (activeSet && !activeSet.has(i)) continue;
          tilePromises.push(this.processTileAsync(screenData, i));
        }
        const results = await Promise.all(tilePromises);
        changedTiles.push(...results);
        return { tiles: changedTiles, currentHashes: Array.from(currentTileHashes.values()) };
      }

      // Find changed tiles by comparing hashes
      for (let i = 0; i < this.totalTiles; i++) {
        if (activeSet && !activeSet.has(i)) continue;
        if (clientTileHashes[i] !== currentTileHashes.get(i)) {
          changedTileIndices.push(i);
        }
      }

      const changePercentage = changedTileIndices.length / this.totalTiles;

      if (changePercentage > this.changeThreshold) {
        // Full refresh - extract all tiles (within focus set)
        const tilePromises = [];
        for (let i = 0; i < this.totalTiles; i++) {
          if (activeSet && !activeSet.has(i)) continue;
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

      this._recordFocusFrame(changedTiles);
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
      remoteLog.warn(`Cleanup error: ${error.message}`);
    }
  }
}
