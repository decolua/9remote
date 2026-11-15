// Tile diffing for the browser stream — the remote-desktop TileManager
// contract, fed from a decoded CDP JPEG instead of an OS capture. The wire
// format is remote's encodeTilesBatch verbatim, so the client reuses the same
// tile decoder. Checksum mirrors TileManager.calculateTileChecksumDirect
// (sheared sampling grid, position-weighted) — keep the two in sync.
import sharp from "sharp";
import { REMOTE_CONFIG } from "../remote/REMOTE_CONFIG.js";
import { encodeJpeg } from "../remote/adapters/encoderAdapter.js";
import { mapLimit } from "../remote/utils/mapLimit.js";
import { BROWSER_TILE_SIZE, STREAM_TILE_QUALITY_BOOST, STREAM_TILE_QUALITY_MAX, STREAM_TILE_SHARP_OPTS } from "./constants.js";

// Sheared sampling: catch 1px vertical carets that a plain grid can miss.
const { rowStep, colStep } = REMOTE_CONFIG.pipeline.checksumSampling;

export function makeGrid(width, height, tileSize) {
  const ts = Math.max(16, tileSize | 0);
  const cols = Math.ceil(width / ts);
  const rows = Math.ceil(height / ts);
  return {
    cols, rows, tileSize: ts, width, height, totalTiles: cols * rows,
    tileRect(tileIndex) {
      const row = Math.floor(tileIndex / cols);
      const col = tileIndex % cols;
      const x = col * ts;
      const y = row * ts;
      return {
        x, y,
        width: Math.min(ts, width - x),
        height: Math.min(ts, height - y)
      };
    }
  };
}

export function tileChecksum(frame, tileIndex, grid) {
  const { x: startX, y: startY, width: tileWidth, height: tileHeight } = grid.tileRect(tileIndex);
  const channels = frame.channels;
  const screenRowBytes = frame.width * channels;
  let sum = 0;
  for (let y = 0; y < tileHeight; y += rowStep) {
    const ox = ((y / rowStep) | 0) % colStep;
    const rowOffset = (startY + y) * screenRowBytes + (startX + ox) * channels;
    for (let x = ox; x < tileWidth; x += colStep) {
      const offset = rowOffset + (x - ox) * channels;
      const w = x + 1;
      sum = (sum + frame.data[offset] * w) >>> 0;
      sum ^= frame.data[offset + 1] << 1;
      sum = (sum + frame.data[offset + 2] * w) >>> 0;
      sum ^= frame.data[offset + 3] << 2;
    }
  }
  return sum >>> 0;
}

/** @returns {{changed:number[], hashes:Map<number,number>}} */
export function diffTiles(prevHashes, frame, grid) {
  const hashes = new Map();
  const changed = [];
  for (let i = 0; i < grid.totalTiles; i++) {
    const c = tileChecksum(frame, i, grid);
    hashes.set(i, c);
    if (!prevHashes || prevHashes.get(i) !== c) changed.push(i);
  }
  return { changed, hashes };
}

/** Decode a Chrome screencast JPEG into raw RGBA. */
export async function decodeJpegRaw(jpeg) {
  const { data, info } = await sharp(jpeg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

/** Tile size for a raster — same ceiling as Remote Desktop: past maxTiles, tiles grow. */
export function computeTileSize(width, height) {
  const base = Math.max(16, BROWSER_TILE_SIZE | 0);
  const { maxTiles, minTileSize } = REMOTE_CONFIG.pipeline;
  if (Math.ceil(width / base) * Math.ceil(height / base) <= maxTiles) return base;
  return Math.max(Math.ceil(Math.sqrt((width * height) / maxTiles)), minTileSize);
}

/** One reusable buffer per encode slot, so a frame does not allocate a tile buffer per tile. */
export function createScratchPool(limit = REMOTE_CONFIG.pipeline.tileConcurrency) {
  const buffers = new Array(Math.max(1, limit | 0));
  return (slotId, bytes) => {
    const slot = Math.max(0, slotId | 0);
    const current = buffers[slot];
    if (current && current.length >= bytes) return current.subarray(0, bytes);
    const next = Buffer.allocUnsafe(bytes);
    buffers[slot] = next;
    return next;
  };
}

/** Encode the changed tiles into remote-desktop tile objects. */
export async function buildTilesBatch(frame, grid, indices, hashes, quality, getScratch = null) {
  // Second lossy generation: boost quality + keep full chroma so the tile
  // never looks softer than the Chrome jpeg it was decoded from.
  const q = Math.min(STREAM_TILE_QUALITY_MAX, (quality || 85) + STREAM_TILE_QUALITY_BOOST);
  // Bounded like TileManager._runTiles: an unbounded Promise.all spikes the CPU
  // on a full-frame change (scroll, resize, modal).
  return mapLimit(indices, REMOTE_CONFIG.pipeline.tileConcurrency, async (i, _idx, slotId) => {
    const { x, y, width, height } = grid.tileRect(i);
    // Extract tile rows out of the full frame into a contiguous RGBA buffer.
    const size = width * height * 4;
    const tileBuf = getScratch ? getScratch(slotId, size) : Buffer.allocUnsafe(size);
    const rowBytes = width * 4;
    const frameRowBytes = frame.width * 4;
    for (let ty = 0; ty < height; ty++) {
      frame.data.copy(tileBuf, ty * rowBytes, (y + ty) * frameRowBytes + x * 4, (y + ty) * frameRowBytes + (x + width) * 4);
    }
    const imageBuffer = await encodeJpeg(tileBuf, width, height, 4, q, "rgba", STREAM_TILE_SHARP_OPTS);
    return { tileIndex: i, x, y, width, height, hash: hashes.get(i) >>> 0, imageBuffer };
  });
}
