// Shared benchmark helpers — synthetic desktop-like buffer, stats, tile grid.
import { performance } from "perf_hooks";

export const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { avg: sum / s.length, p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
};
export const ms = (o) => `avg=${o.avg.toFixed(2)} p50=${o.p50.toFixed(2)} p95=${o.p95.toFixed(2)} max=${o.max.toFixed(2)}`;
export const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

export async function timeIt(iter, fn) {
  const times = [];
  let last;
  for (let i = 0; i < iter; i++) {
    const t = performance.now();
    last = await fn(i);
    times.push(performance.now() - t);
  }
  return { times, stat: stat(times), last };
}

// Desktop-like content: gradients + solid blocks + light dither (compressible, realistic).
export function makeSynthetic(width, height, channels = 4) {
  const buf = Buffer.allocUnsafe(width * height * channels);
  let seed = 0x12345678;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const block = (((x >> 7) + (y >> 7)) & 1) * 40;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const dither = (seed >> 20) & 7;
      buf[i] = (80 + block + ((x * 120 / width) | 0) + dither) & 0xff;
      buf[i + 1] = (90 + block + ((y * 100 / height) | 0) + dither) & 0xff;
      buf[i + 2] = (120 + block + dither) & 0xff;
      if (channels === 4) buf[i + 3] = 255;
    }
  }
  return { buffer: buf, width, height, channels };
}

export const TILE = 128;
export const CONCURRENCY = 6;

export function tileGrid(width, height, tile = TILE) {
  const cols = Math.ceil(width / tile), rows = Math.ceil(height / tile);
  const tiles = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = c * tile, y = r * tile;
      tiles.push({ x, y, w: Math.min(tile, width - x), h: Math.min(tile, height - y) });
    }
  return tiles;
}

export function extractTile(screen, startX, startY, tileW, tileH) {
  const ch = screen.channels;
  const rowBytes = tileW * ch;
  const buf = Buffer.allocUnsafe(tileW * tileH * ch);
  for (let y = 0; y < tileH; y++) {
    const src = ((startY + y) * screen.width + startX) * ch;
    screen.buffer.copy(buf, y * rowBytes, src, src + rowBytes);
  }
  return buf;
}

export const DIMS = { w: 2940, h: 1912 };  // typical retina capture (matches this machine)
