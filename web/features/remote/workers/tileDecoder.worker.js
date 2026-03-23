/**
 * TileDecoder Worker — decode binary tile batch + createImageBitmap off main thread.
 * Format: [4-byte tileCount] + [8-byte timestamp Float64BE] + N × [24-byte header + JPEG bytes]
 * Header: tileIndex(4) x(4) y(4) width(4) height(4) imageSize(4)
 *
 * If createImageBitmap is supported (Chrome/Firefox/Safari 15+):
 *   → decode JPEG to ImageBitmap here, transfer to main thread (zero-copy)
 * Else (Safari < 15):
 *   → transfer raw imageBuffer back, main thread decodes
 */

const _supportsBitmap = typeof createImageBitmap !== "undefined";

async function decodeBatch(buffer, id) {
  const view = new DataView(buffer);
  const tileCount = view.getUint32(0, true);
  // Server timestamp embedded in binary — use for stale detection on client
  const timestamp = view.getFloat64(4, false);
  const tileMetas = [];

  // Parse tile headers starting at offset 12
  let offset = 12;
  for (let i = 0; i < tileCount; i++) {
    if (offset + 24 > buffer.byteLength) break;
    const tileIndex = view.getUint32(offset, true);
    const x         = view.getUint32(offset + 4, true);
    const y         = view.getUint32(offset + 8, true);
    const width     = view.getUint32(offset + 12, true);
    const height    = view.getUint32(offset + 16, true);
    const imageSize = view.getUint32(offset + 20, true);
    if (offset + 24 + imageSize > buffer.byteLength) break;
    const imageBuffer = buffer.slice(offset + 24, offset + 24 + imageSize);
    tileMetas.push({ tileIndex, x, y, width, height, imageBuffer });
    offset += 24 + imageSize;
  }

  if (_supportsBitmap) {
    // Decode all tiles to ImageBitmap in parallel (off main thread)
    const bitmaps = await Promise.all(
      tileMetas.map(t =>
        createImageBitmap(new Blob([t.imageBuffer], { type: "image/jpeg" }))
          .catch(() => null)
      )
    );

    const tiles = tileMetas.map((t, i) => ({
      tileIndex: t.tileIndex,
      x: t.x, y: t.y,
      width: t.width, height: t.height,
      bitmap: bitmaps[i] // ImageBitmap, ready to drawImage
    }));

    // Transfer all bitmaps (zero-copy)
    const transferables = bitmaps.filter(Boolean);
    self.postMessage({ tiles, timestamp, id, hasBitmap: true }, transferables);
  } else {
    // Fallback: transfer raw buffers, main thread will createImageBitmap
    const transferables = tileMetas.map(t => t.imageBuffer);
    const tiles = tileMetas.map(t => ({
      tileIndex: t.tileIndex,
      x: t.x, y: t.y,
      width: t.width, height: t.height,
      imageBuffer: t.imageBuffer
    }));
    self.postMessage({ tiles, timestamp, id, hasBitmap: false }, transferables);
  }
}

self.onmessage = ({ data: { buffer, id } }) => {
  decodeBatch(buffer, id).catch(err => {
    self.postMessage({ error: err.message, id });
  });
};
