import fs from "fs";
import path from "path";
import sharp from "sharp";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { REMOTE_CONFIG } from "./REMOTE_CONFIG.js";
import * as capture from "./adapters/captureAdapter.js";
import { encodeJpeg, bgraToRgbaInPlace } from "./adapters/encoderAdapter.js";
import { getGpuResize, resizeTile, resizeTilesBatch } from "./adapters/gpuResize.js";
import { getVImageResize, resizeTileVImage } from "./adapters/vImageResize.js";
import { FrameMetrics } from "./metrics.js";
import { remoteLog } from "./utils/remoteLog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Map with bounded concurrency, preserving order; slotId (0..limit-1) is stable per worker.
export async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  const width = Math.min(limit, items.length);
  const workers = Array.from({ length: width }, async (_, slotId) => {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx, slotId);
    }
  });
  await Promise.all(workers);
  return ret;
}

export class TileManager {
  constructor(robot, opts = {}) {
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
    this.focusStats = { frames: 0, scanned: 0, changed: 0, bytes: 0 };

    this._scratchExtract = [];
    this._scratchSwap = [];
    this._scratchPack = [];
    this._scratchPackOut = [];
    this._prefetchCapture = null;

    // When monitor is supplied, capture uses native physical pixels directly.
    this._monitor = opts.monitor ?? null;

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    capture.initCapture(robot);
    if (this._monitor) {
      this._initFromMonitor(this._monitor);
    } else {
      this.initializeScreenDimensions();
    }
  }

  // Darwin monitor dims are points while captureImage() returns pixels (scaled by scaleFactor).
  _initFromMonitor(mon) {
    this.screenWidth = mon.width();
    this.screenHeight = mon.height();
    this.dpiScale = process.platform === "darwin" ? (mon.scaleFactor() || 1) : 1;
    this.captureWidth = Math.round(this.screenWidth * this.dpiScale);
    this.captureHeight = Math.round(this.screenHeight * this.dpiScale);
    this._applyTileGeometry();
  }

  setMonitor(mon) {
    if (!mon) return;
    this._monitor = mon;
    this._initFromMonitor(mon);
    this.lastTileChecksums.clear();
    this.sharedScreenCache = null;
    this.lastCaptureTime = 0;
    this._prefetchCapture = null;
    this._scratchExtract = [];
    this._scratchSwap = [];
    this._scratchPack = [];
    this._scratchPackOut = [];
    this.activeTileSet = null;
  }

  _applyTileGeometry() {
    this.tileSize = REMOTE_CONFIG.pipeline.tileSize;
    this.scaledWidth = this.captureWidth;
    this.scaledHeight = this.captureHeight;
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
  }

  initializeScreenDimensions() {
    try {
      const { width, height } = this.robot.getScreenSize();
      this.screenWidth = width;
      this.screenHeight = height;
      this.detectDpiScale();
      this._applyTileGeometry();
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
      const testCapture = this.robot.screen.capture(0, 0, this.screenWidth, this.screenHeight);
      const actualWidth = testCapture.byteWidth / testCapture.bytesPerPixel;
      const scale = actualWidth / this.screenWidth;

      if (scale >= 1.9 && scale <= 2.1) {
        this.dpiScale = 2;
      } else {
        this.dpiScale = 1;
      }
    } else if (process.platform === "win32") {
      this.dpiScale = this._detectDpiScaleWin32();
    } else {
      this.dpiScale = 1;
    }

    this.captureWidth = Math.floor(this.screenWidth * this.dpiScale);
    this.captureHeight = Math.floor(this.screenHeight * this.dpiScale);
  }

  _detectDpiScaleWin32() {
    remoteLog.dpi(`🔍 [DPI Detection] screenWidth from robot: ${this.screenWidth}x${this.screenHeight}`);

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
    const result = await capture.captureFull(this._monitor);
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

  async getCaptureForStreaming() {
    if (!this._prefetchCapture) {
      const data = await this.captureFullScreen();
      this._prefetchCapture = this.captureFullScreen();
      return data;
    }
    let data;
    try {
      data = await this._prefetchCapture;
    } catch (err) {
      this._prefetchCapture = null;
      throw err;
    }
    this._prefetchCapture = this.captureFullScreen();
    return data;
  }

  clearScreenCache() {}

  async detectChangedTiles() {
    const result = await this.detectChangedTilesWithHashes();
    return result.tiles;
  }

  async detectChangedTilesWithHashes() {
    if (this.isProcessing) return { tiles: [], currentHashes: Array.from(this.lastTileChecksums.values()) };
    this.isProcessing = true;

    const tStart = this.metrics.now();
    let tCaptureEnd = tStart, tChecksumEnd = tStart;

    try {
      const screenData = await this.getCaptureForStreaming();
      tCaptureEnd = this.metrics.now();

      const changedTiles = [];
      const changedTileIndices = [];
      const currentTileHashes = new Map();
      this.frameCount++;

      const activeSet = this.activeTileSet;

      for (let i = 0; i < this.totalTiles; i++) {
        if (activeSet && !activeSet.has(i)) continue;
        const checksum = this.calculateTileChecksumDirect(screenData, i);
        currentTileHashes.set(i, checksum);
      }
      tChecksumEnd = this.metrics.now();

      const currentHashes = Array.from(currentTileHashes.values());

      if (this.lastTileChecksums.size === 0) {
        const indices = [];
        for (let i = 0; i < this.totalTiles; i++) {
          if (activeSet && !activeSet.has(i)) continue;
          indices.push(i);
        }
        const results = await this._runTiles(screenData, indices, currentTileHashes);
        changedTiles.push(...results);
        this._recordFrame(tStart, tCaptureEnd, tChecksumEnd, changedTiles, screenData);
        return { tiles: changedTiles, currentHashes };
      }

      for (let i = 0; i < this.totalTiles; i++) {
        if (activeSet && !activeSet.has(i)) continue;
        const checksum = currentTileHashes.get(i);
        const lastChecksum = this.lastTileChecksums.get(i);
        if (checksum !== lastChecksum) {
          changedTileIndices.push(i);
        }
      }

      const changePercentage = changedTileIndices.length / this.totalTiles;

      if (changePercentage > this.changeThreshold) {
        const indices = [];
        for (let i = 0; i < this.totalTiles; i++) {
          if (activeSet && !activeSet.has(i)) continue;
          indices.push(i);
        }
        const results = await this._runTiles(screenData, indices, currentTileHashes);
        changedTiles.push(...results.map(t => ({ ...t, fullRefresh: true })));
      } else if (changedTileIndices.length > 0) {
        const results = await this._runTiles(screenData, changedTileIndices, currentTileHashes);
        changedTiles.push(...results);
      }

      this._recordFrame(tStart, tCaptureEnd, tChecksumEnd, changedTiles, screenData);

      return { tiles: changedTiles, currentHashes };
    } finally {
      this.isProcessing = false;
    }
  }

  async processTileAsync(screenData, tileIndex, cachedTileData = null, hashOverride = null, slotId = null, preResized = null) {
    const pre = preResized?.get(tileIndex);
    const { row, col } = this.getTilePosition(tileIndex);
    if (pre) {
      const imageBuffer = await encodeJpeg(pre.buffer, pre.width, pre.height, 4, this.compressionQuality, "rgba");
      return {
        type: "tile-update",
        tileIndex,
        x: col * this.tileSize,
        y: row * this.tileSize,
        width: pre.srcWidth,
        height: pre.srcHeight,
        imageBuffer,
        hash: hashOverride ?? this.lastTileChecksums.get(tileIndex) ?? 0,
        timestamp: Date.now(),
        frameCount: this.frameCount
      };
    }

    const tileData = cachedTileData || this.extractTile(screenData, tileIndex, slotId);
    const imageBuffer = await this.compressTileImage(tileData.buffer, tileData.width, tileData.height, slotId);

    return {
      type: "tile-update",
      tileIndex,
      x: col * this.tileSize,
      y: row * this.tileSize,
      width: tileData.width,
      height: tileData.height,
      imageBuffer,
      hash: hashOverride ?? this.lastTileChecksums.get(tileIndex) ?? 0,
      timestamp: Date.now(),
      frameCount: this.frameCount
    };
  }

  commitHashes(sentTiles) {
    for (const t of sentTiles) this.lastTileChecksums.set(t.tileIndex, t.hash);
  }

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
    const { rowStep, colStep } = REMOTE_CONFIG.pipeline.checksumSampling;

    for (let y = 0; y < tileHeight; y += rowStep) {
      // Sheared grid: shift sampled row by +1px (mod colStep) to catch 1px vertical carets.
      const ox = ((y / rowStep) | 0) % colStep;
      const rowOffset = (startY + y) * screenRowBytes + (startX + ox) * channels;
      for (let x = ox; x < tileWidth; x += colStep) {
        const offset = rowOffset + (x - ox) * channels;
        // Position-weighted to prevent thin-caret pixel deltas cancelling out.
        const w = x + 1;
        sum = (sum + screenData.buffer[offset] * w) >>> 0;
        sum ^= screenData.buffer[offset + 1] << 1;
        sum = (sum + screenData.buffer[offset + 2] * w) >>> 0;
        sum ^= screenData.buffer[offset + 3] << 2;
      }
    }
    return sum >>> 0;
  }

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

  _getScratch(pool, slotId, size) {
    let buf = pool[slotId];
    if (!buf || buf.length < size) {
      buf = Buffer.allocUnsafe(size);
      pool[slotId] = buf;
    }
    return buf.subarray(0, size);
  }

  extractTile(screenData, tileIndex, slotId = null) {
    const { row, col } = this.getTilePosition(tileIndex);
    const startX = col * this.tileSize;
    const startY = row * this.tileSize;
    const endX = Math.min(startX + this.tileSize, screenData.width);
    const endY = Math.min(startY + this.tileSize, screenData.height);
    const tileWidth = endX - startX;
    const tileHeight = endY - startY;
    const channels = screenData.channels;
    const rowBytes = tileWidth * channels;
    const size = tileWidth * tileHeight * channels;

    const tileBuffer = slotId === null
      ? Buffer.allocUnsafe(size)
      : this._getScratch(this._scratchExtract, slotId, size);

    for (let y = 0; y < tileHeight; y++) {
      const srcOffset = ((startY + y) * screenData.width + startX) * channels;
      const dstOffset = y * rowBytes;
      screenData.buffer.copy(tileBuffer, dstOffset, srcOffset, srcOffset + rowBytes);
    }

    return { buffer: tileBuffer, width: tileWidth, height: tileHeight, channels, tileIndex, x: startX, y: startY };
  }

  _stats() {
    if (!this._resizeStats) {
      this._resizeStats = { frames: 0, tiles: 0, gpuBatch: 0, gpu: 0, vImage: 0, sharp: 0, fallbacks: 0, batchMs: 0, procMs: 0 };
    }
    return this._resizeStats;
  }

  _batchResize(screenData, indices) {
    const p = REMOTE_CONFIG.pipeline;
    const scale = this.scaleFactor;
    if (!p.gpuBatchResize || !(scale > 0 && scale < 1)) return null;
    const gpu = getGpuResize();
    if (!gpu) return null;

    const ts = this.tileSize;
    if (screenData.channels !== 4 || ts * ts * 4 > gpu.maxTileBytes) return null;
    const targetW = Math.max(1, Math.floor(ts * scale));
    const targetH = targetW;
    const full = indices.filter((i) => {
      const { row, col } = this.getTilePosition(i);
      return col * ts + ts <= screenData.width && row * ts + ts <= screenData.height;
    });
    if (full.length < (p.gpuBatchMinTiles || 2)) return null;

    const channels = screenData.channels;
    const tileBytes = ts * ts * channels;
    const rowBytes = ts * channels;
    const outTileBytes = targetW * targetH * 4;
    const chunkMax = gpu.maxBatchTiles;
    const outAll = this._getScratch(this._scratchPackOut, 0, full.length * outTileBytes);
    const packed = this._getScratch(this._scratchPack, 0, Math.min(full.length, chunkMax) * tileBytes);

    const map = new Map();
    for (let start = 0; start < full.length; start += chunkMax) {
      const n = Math.min(chunkMax, full.length - start);
      for (let t = 0; t < n; t++) {
        const { row, col } = this.getTilePosition(full[start + t]);
        const base = t * tileBytes;
        for (let y = 0; y < ts; y++) {
          const src = ((row * ts + y) * screenData.width + col * ts) * channels;
          screenData.buffer.copy(packed, base + y * rowBytes, src, src + rowBytes);
        }
      }
      if (p.inputFormat === "bgra") bgraToRgbaInPlace(packed.subarray(0, n * tileBytes));

      const slice = outAll.subarray(start * outTileBytes, (start + n) * outTileBytes);
      try {
        resizeTilesBatch(gpu, packed, n, ts, ts, targetW, targetH, slice);
      } catch (e) {
        this._stats().fallbacks++;
        remoteLog.error("gpu batch resize failed, per-tile fallback:", e.message);
        return map.size ? map : null;
      }
      for (let t = 0; t < n; t++) {
        const off = (start + t) * outTileBytes;
        map.set(full[start + t], {
          buffer: outAll.subarray(off, off + outTileBytes),
          width: targetW,
          height: targetH,
          srcWidth: ts,
          srcHeight: ts
        });
      }
      this._stats().gpuBatch += n;
    }
    return map;
  }

  async _runTiles(screenData, indices, currentTileHashes) {
    const t0 = performance.now();
    const pre = this._batchResize(screenData, indices);
    const t1 = performance.now();
    const results = await mapLimit(indices, REMOTE_CONFIG.pipeline.tileConcurrency,
      (i, _idx, slot) => this.processTileAsync(screenData, i, null, currentTileHashes.get(i), slot, pre));
    this._recordResizeStats(indices.length, t1 - t0, performance.now() - t1);
    return results;
  }

  _recordResizeStats(tiles, batchMs, procMs) {
    if (!REMOTE_CONFIG.logging.resizeStats) return;
    const s = this._stats();
    s.frames++; s.tiles += tiles; s.batchMs += batchMs; s.procMs += procMs;
    const every = REMOTE_CONFIG.logging.resizeStatsEveryFrames || 60;
    if (s.frames < every) return;
    const per = (v) => (v / s.frames).toFixed(2);
    const resized = s.gpuBatch + s.gpu + s.vImage + s.sharp;
    remoteLog.stats(`📐 [Resize/${s.frames}f] ${per(s.tiles)} tiles/f | scale ${this.scaleFactor} | resized ${resized}/${Math.round(s.tiles)} → gpuBatch ${s.gpuBatch} gpu ${s.gpu} vImage ${s.vImage} sharp ${s.sharp} | fallback ${s.fallbacks} | batch ${per(s.batchMs)}ms encode ${per(s.procMs)}ms per frame`);
    this._resizeStats = { frames: 0, tiles: 0, gpuBatch: 0, gpu: 0, vImage: 0, sharp: 0, fallbacks: 0, batchMs: 0, procMs: 0 };
  }

  async compressTileImage(buffer, width, height, slotId = null) {
    const scale = this.scaleFactor;
    if (scale && scale > 0 && scale < 1) {
      const targetW = Math.max(1, Math.floor(width * scale));
      const targetH = Math.max(1, Math.floor(height * scale));
      // Sharp requires RGBA; swap BGRA->RGBA in a copy first if needed.
      const { inputFormat } = REMOTE_CONFIG.pipeline;
      let raw = buffer;
      let channels = 4;
      if (inputFormat === "bgra") {
        if (slotId === null) {
          raw = Buffer.from(buffer);
        } else {
          raw = this._getScratch(this._scratchSwap, slotId, buffer.length);
          buffer.copy(raw);
        }
        bgraToRgbaInPlace(raw);
      }
      const gpu = REMOTE_CONFIG.pipeline.gpuResize ? getGpuResize() : null;
      if (gpu) {
        try {
          const resized = resizeTile(gpu, "bilinear", raw, width, height, targetW, targetH);
          this._stats().gpu++;
          return encodeJpeg(resized, targetW, targetH, channels, this.compressionQuality);
        } catch (e) {
          this._stats().fallbacks++;
          remoteLog.error("gpuResize failed, sharp fallback:", e.message);
        }
      }
      // vImage matches sharp on square tiles; edge tiles use sharp.
      const vi = REMOTE_CONFIG.pipeline.vImageResize && width === height ? getVImageResize() : null;
      if (vi) {
        try {
          const resized = resizeTileVImage(vi, raw, width, height, targetW, targetH, slotId);
          this._stats().vImage++;
          return encodeJpeg(resized, targetW, targetH, channels, this.compressionQuality);
        } catch (e) {
          this._stats().fallbacks++;
          remoteLog.error("vImageResize failed, sharp fallback:", e.message);
        }
      }
      this._stats().sharp++;
      const { tileFormat, webpEffort } = REMOTE_CONFIG.pipeline;
      const resized = sharp(raw, { raw: { width, height, channels } })
        .resize(targetW, targetH, { kernel: "lanczos3", fastShrinkOnLoad: false });
      return tileFormat === "webp"
        ? resized.webp({ quality: this.compressionQuality, effort: webpEffort }).toBuffer()
        : resized.jpeg({ quality: this.compressionQuality }).toBuffer();
    }
    return encodeJpeg(buffer, width, height, 4, this.compressionQuality);
  }

  pickProfile({ zoom = 1, viewerWidth = 0, dpr = 1 } = {}) {
    const hostW = this.captureWidth || this.screenWidth || 1;
    const vw = viewerWidth > 0 ? viewerWidth : hostW;
    const z = zoom > 0 ? zoom : 1;
    const d = dpr > 0 ? dpr : 1;
    const effective = (vw * z * d) / hostW;

    const pipeline = REMOTE_CONFIG.pipeline;
    if (pipeline.scaleMode !== "smooth") {
      const tiers = pipeline.adaptiveTiers || [];
      if (!tiers.length) return null;
      const margin = pipeline.tierHysteresis || 0;
      const prev = this._currentTier;
      for (const t of tiers) {
        const threshold = prev && t === prev ? t.minEffective - margin : t.minEffective;
        if (effective >= threshold) {
          this._currentTier = t;
          return t;
        }
      }
      const last = tiers[tiers.length - 1];
      this._currentTier = last;
      return last;
    }

    const minS = pipeline.minOutputScale ?? 0.25;
    const maxS = pipeline.maxOutputScale ?? 1;
    const outputScale = Math.max(minS, Math.min(maxS, effective));
    const profile = { outputScale, jpegQuality: pipeline.qualityFloor ?? 80 };
    this._currentTier = profile;
    return profile;
  }

  setProfile(profile) {
    if (!profile) return;
    const nextScale = profile.outputScale ?? this.scaleFactor;
    const nextQuality = profile.jpegQuality ?? this.compressionQuality;
    if (nextScale === this.scaleFactor && nextQuality === this.compressionQuality) return;

    this.scaleFactor = nextScale;
    this.compressionQuality = nextQuality;
    this.lastTileChecksums.clear();
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
      const now = Date.now();
      if (!this.lastDimErrorAt || now - this.lastDimErrorAt > 10000) {
        remoteLog.error("Error getting dimensions:", error);
        this.lastDimErrorAt = now;
      }
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

      const activeSet = this.activeTileSet;

      const currentTileHashes = new Map();
      for (let i = 0; i < this.totalTiles; i++) {
        if (activeSet && !activeSet.has(i)) continue;
        const checksum = this.calculateTileChecksumDirect(screenData, i);
        currentTileHashes.set(i, checksum);
        this.lastTileChecksums.set(i, checksum);
      }

      if (!clientTileHashes || clientTileHashes.length === 0) {
        const indices = [];
        for (let i = 0; i < this.totalTiles; i++) {
          if (activeSet && !activeSet.has(i)) continue;
          indices.push(i);
        }
        const results = await mapLimit(indices, REMOTE_CONFIG.pipeline.tileConcurrency, i => this.processTileAsync(screenData, i));
        changedTiles.push(...results);
        return { tiles: changedTiles, currentHashes: Array.from(currentTileHashes.values()) };
      }

      for (let i = 0; i < this.totalTiles; i++) {
        if (activeSet && !activeSet.has(i)) continue;
        if (clientTileHashes[i] !== currentTileHashes.get(i)) {
          changedTileIndices.push(i);
        }
      }

      const changePercentage = changedTileIndices.length / this.totalTiles;

      if (changePercentage > this.changeThreshold) {
        const indices = [];
        for (let i = 0; i < this.totalTiles; i++) {
          if (activeSet && !activeSet.has(i)) continue;
          indices.push(i);
        }
        const results = await mapLimit(indices, REMOTE_CONFIG.pipeline.tileConcurrency, i => this.processTileAsync(screenData, i));
        changedTiles.push(...results.map(t => ({ ...t, fullRefresh: true })));
      } else if (changedTileIndices.length > 0) {
        const results = await mapLimit(changedTileIndices, REMOTE_CONFIG.pipeline.tileConcurrency, i => this.processTileAsync(screenData, i));
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
    this._scratchExtract = [];
    this._scratchSwap = [];
    this._traceFrames = 50;
    this._prefetchCapture = null;
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
