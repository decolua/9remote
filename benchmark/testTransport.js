// Transport benchmark: JSON (base64) vs JSON (raw Buffer) vs Binary pack
// Tests the overhead of serialization formats for tile streaming.
import sharp from "sharp";
import { Monitor } from "node-screenshots";
import { performance } from "perf_hooks";
// socket.io parser is what socket.io uses internally for encoding
import * as socketIoParser from "socket.io-parser";

const TILE = 128;
const QUALITY = 50;
const ITER = 100;

// 1. Capture 1 frame
const monitor = Monitor.all()[0];
const image = monitor.captureImageSync();
const rgba = image.toRawSync ? image.toRawSync() : image.rawSync();
const W = image.width, H = image.height;
console.log(`📸 ${W}x${H} RGBA\n`);

// 2. Build tiles with JPEG
const tiles = [];
const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const x = c * TILE, y = r * TILE;
    const tw = Math.min(TILE, W - x), th = Math.min(TILE, H - y);
    const buf = Buffer.alloc(tw * th * 4);
    for (let yy = 0; yy < th; yy++) {
      const src = ((y + yy) * W + x) * 4;
      rgba.copy(buf, yy * tw * 4, src, src + tw * 4);
    }
    const jpeg = await sharp(buf, { raw: { width: tw, height: th, channels: 4 } })
      .jpeg({ quality: QUALITY })
      .toBuffer();
    tiles.push({
      type: "tile-update",
      tileIndex: r * cols + c,
      x, y, width: tw, height: th,
      imageBuffer: jpeg,
      timestamp: Date.now(),
      frameCount: 1
    });
  }
}
const totalJpegBytes = tiles.reduce((s, t) => s + t.imageBuffer.length, 0);
console.log(`🧩 ${tiles.length} tiles, total JPEG ${(totalJpegBytes / 1024).toFixed(1)}KB\n`);

// ── Methods ──────────────────────────────────────────────────────────────

// Method 1: JSON + base64 (worst case, classic legacy)
function encodeJsonBase64() {
  const payload = {
    tiles: tiles.map(t => ({ ...t, imageBuffer: t.imageBuffer.toString("base64") })),
    timestamp: Date.now()
  };
  return Buffer.from(JSON.stringify(payload));
}
function decodeJsonBase64(buf) {
  const obj = JSON.parse(buf.toString());
  return obj.tiles.map(t => ({ ...t, imageBuffer: Buffer.from(t.imageBuffer, "base64") }));
}

// Method 2: socket.io-parser encode (what socket.io actually does with Buffer → binary attachments + JSON meta)
const Encoder = socketIoParser.Encoder;
const Decoder = socketIoParser.Decoder;
function encodeSocketIo() {
  const packet = { type: 2, nsp: "/", data: ["tiles-data", { tiles, timestamp: Date.now() }] };
  const enc = new Encoder();
  const encoded = enc.encode(packet);
  return encoded; // array of strings + Buffers
}
function encodeSocketIoSize(encoded) {
  let size = 0;
  for (const e of encoded) size += typeof e === "string" ? Buffer.byteLength(e) : e.length;
  return size;
}

// Method 3: Custom binary pack (what WebRTC DataChannel uses)
function encodeBinaryPack() {
  const batchHeader = Buffer.alloc(12);
  batchHeader.writeUInt32LE(tiles.length, 0);
  batchHeader.writeDoubleBE(Date.now(), 4);
  const parts = [batchHeader];
  for (const t of tiles) {
    const header = Buffer.alloc(24);
    header.writeUInt32LE(t.tileIndex, 0);
    header.writeUInt32LE(t.x, 4);
    header.writeUInt32LE(t.y, 8);
    header.writeUInt32LE(t.width, 12);
    header.writeUInt32LE(t.height, 16);
    header.writeUInt32LE(t.imageBuffer.length, 20);
    parts.push(header, t.imageBuffer);
  }
  return Buffer.concat(parts);
}
function decodeBinaryPack(buf) {
  const count = buf.readUInt32LE(0);
  const out = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const tileIndex = buf.readUInt32LE(offset);
    const x = buf.readUInt32LE(offset + 4);
    const y = buf.readUInt32LE(offset + 8);
    const width = buf.readUInt32LE(offset + 12);
    const height = buf.readUInt32LE(offset + 16);
    const len = buf.readUInt32LE(offset + 20);
    offset += 24;
    out.push({ tileIndex, x, y, width, height, imageBuffer: buf.subarray(offset, offset + len) });
    offset += len;
  }
  return out;
}

// ── Benchmark ────────────────────────────────────────────────────────────

function bench(label, encodeFn, sizeFn, decodeFn) {
  // Size (1 run)
  const sample = encodeFn();
  const size = sizeFn ? sizeFn(sample) : sample.length;

  // Encode timing
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) encodeFn();
  const encMs = (performance.now() - t0) / ITER;

  // Decode timing (if provided)
  let decMs = 0;
  if (decodeFn) {
    const t1 = performance.now();
    for (let i = 0; i < ITER; i++) decodeFn(sample);
    decMs = (performance.now() - t1) / ITER;
  }

  const overhead = ((size / totalJpegBytes) * 100 - 100).toFixed(1);
  console.log(
    `${label.padEnd(22)} | size ${(size / 1024).toFixed(1).padStart(7)}KB | ` +
    `overhead +${overhead.padStart(5)}% | encode ${encMs.toFixed(2).padStart(5)}ms | ` +
    `decode ${decMs.toFixed(2).padStart(5)}ms`
  );
}

console.log(`Method                 | Size       | Overhead  | Encode   | Decode`);
console.log("─".repeat(100));

bench("JSON + base64",  encodeJsonBase64,  null, decodeJsonBase64);
bench("socket.io parser", encodeSocketIo,  encodeSocketIoSize, null);
bench("Binary pack",     encodeBinaryPack, null, decodeBinaryPack);

console.log(`\n💡 Raw JPEG total: ${(totalJpegBytes / 1024).toFixed(1)}KB (baseline, 0% overhead)`);
