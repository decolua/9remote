/**
 * TileDecoder Worker — decode binary tile batch + createImageBitmap off main thread.
 *
 * Batch: [4B tileCount LE] [8B timestamp Float64BE] + N × tileHeader + JPEG bytes
 * Tile header v1 (24B): tileIndex(4) x(4) y(4) width(4) height(4) imageSize(4)
 * Tile header v2 (28B): v1 + hash(4)
 */

const _supportsBitmap = typeof createImageBitmap !== "undefined";
const HEADER_SIZE = { 1: 24, 2: 28 };

async function decodeBatch(buffer, id, v = 1) {
  const view = new DataView(buffer);
  const tileCount = view.getUint32(0, true);
  const timestamp = view.getFloat64(4, false);
  const headerSize = HEADER_SIZE[v] || 24;
  const tileMetas = [];

  let offset = 12;
  for (let i = 0; i < tileCount; i++) {
    if (offset + headerSize > buffer.byteLength) break;
    const tileIndex = view.getUint32(offset, true);
    const x         = view.getUint32(offset + 4, true);
    const y         = view.getUint32(offset + 8, true);
    const width     = view.getUint32(offset + 12, true);
    const height    = view.getUint32(offset + 16, true);
    const imageSize = view.getUint32(offset + 20, true);
    const hash      = v === 2 ? view.getUint32(offset + 24, true) : null;
    if (offset + headerSize + imageSize > buffer.byteLength) break;
    const imageBuffer = buffer.slice(offset + headerSize, offset + headerSize + imageSize);
    tileMetas.push({ tileIndex, x, y, width, height, imageBuffer, hash });
    offset += headerSize + imageSize;
  }

  if (_supportsBitmap) {
    const bitmaps = await Promise.all(
      tileMetas.map(t =>
        createImageBitmap(new Blob([t.imageBuffer]))
          .catch(() => null)
      )
    );

    const tiles = tileMetas.map((t, i) => ({
      tileIndex: t.tileIndex,
      x: t.x, y: t.y,
      width: t.width, height: t.height,
      hash: t.hash,
      bitmap: bitmaps[i]
    }));

    const transferables = bitmaps.filter(Boolean);
    self.postMessage({ tiles, timestamp, id, hasBitmap: true }, transferables);
  } else {
    const transferables = tileMetas.map(t => t.imageBuffer);
    const tiles = tileMetas.map(t => ({
      tileIndex: t.tileIndex,
      x: t.x, y: t.y,
      width: t.width, height: t.height,
      hash: t.hash,
      imageBuffer: t.imageBuffer
    }));
    self.postMessage({ tiles, timestamp, id, hasBitmap: false }, transferables);
  }
}

self.onmessage = ({ data: { buffer, id, v } }) => {
  decodeBatch(buffer, id, v).catch(err => {
    self.postMessage({ error: err.message, id });
  });
};
