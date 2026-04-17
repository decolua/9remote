// Compression test: sharp vs jpeg-turbo at same quality
// Run: node testCompression.js
import { Monitor } from "node-screenshots";
import sharp from "sharp";
import jpegTurboModule from "@julusian/jpeg-turbo";

const jpegTurbo = jpegTurboModule.default || jpegTurboModule;
const TILE = 128;
const QUALITIES = [30, 50, 70, 80];

// Capture full screen via node-screenshots (returns RGBA, no conflict with robotjs)
const monitor = Monitor.all()[0];
const image = monitor.captureImageSync();
const rgba = image.toRawSync ? image.toRawSync() : image.rawSync();
const W = image.width;
const H = image.height;
const rawSize = rgba.length;
console.log(`📸 Captured ${W}x${H} RGBA (${(rawSize / 1024 / 1024).toFixed(1)}MB)\n`);

// Build BGRA copy for jpeg-turbo FORMAT_BGRA
const bgra = Buffer.from(rgba);
const u32 = new Uint32Array(bgra.buffer, bgra.byteOffset, bgra.length >> 2);
for (let i = 0; i < u32.length; i++) {
  const p = u32[i];
  u32[i] = (p & 0xff00ff00) | ((p & 0x00ff0000) >> 16) | ((p & 0x000000ff) << 16);
}

// Extract all tiles as { bgraBuf, rgbaBuf, w, h }
const tiles = [];
const cols = Math.ceil(W / TILE);
const rows = Math.ceil(H / TILE);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const x = c * TILE, y = r * TILE;
    const tw = Math.min(TILE, W - x);
    const th = Math.min(TILE, H - y);
    const bgraT = Buffer.alloc(tw * th * 4);
    const rgbaT = Buffer.alloc(tw * th * 4);
    for (let yy = 0; yy < th; yy++) {
      const src = ((y + yy) * W + x) * 4;
      bgra.copy(bgraT, yy * tw * 4, src, src + tw * 4);
      rgba.copy(rgbaT, yy * tw * 4, src, src + tw * 4);
    }
    tiles.push({ bgraT, rgbaT, tw, th });
  }
}
console.log(`🧩 ${tiles.length} tiles (${cols}x${rows}) @ ${TILE}px\n`);

// Run & measure
async function run(label, fn) {
  const sizes = [];
  const t0 = performance.now();
  for (const t of tiles) {
    const buf = await fn(t);
    sizes.push(buf.length);
  }
  const totalMs = performance.now() - t0;
  let total = 0, min = Infinity, max = 0;
  for (const s of sizes) { total += s; if (s < min) min = s; if (s > max) max = s; }
  const avg = total / sizes.length;
  const ratio = rawSize / total;
  console.log(
    `${label.padEnd(22)} | total ${(total / 1024).toFixed(1).padStart(7)}KB | ` +
    `avg ${(avg / 1024).toFixed(2).padStart(5)}KB | min ${(min / 1024).toFixed(2)} | max ${(max / 1024).toFixed(2)} | ` +
    `compress ${ratio.toFixed(0).padStart(4)}x | encode ${totalMs.toFixed(0).padStart(4)}ms`
  );
}

console.log("Encoder              | Total      | Avg     | Min  | Max  | Ratio | Time");
console.log("─".repeat(100));

for (const q of QUALITIES) {
  await run(`sharp q${q}`, (t) =>
    sharp(t.rgbaT, { raw: { width: t.tw, height: t.th, channels: 4 } })
      .jpeg({ quality: q })
      .toBuffer()
  );
  await run(`jpegTurbo q${q}`, async (t) =>
    jpegTurbo.compressSync(t.bgraT, { width: t.tw, height: t.th, format: jpegTurbo.FORMAT_BGRA, quality: q })
  );
  console.log("");
}
