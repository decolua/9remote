// Frame capture (real DXGI) + bench harness shared by all steps.
import { Monitor } from "node-screenshots";

const DEFAULT_WARMUP = 3;
const DEFAULT_SAMPLES = 10;

let _frame = null;
let _monitor = null;

export function getMonitor() {
  if (_monitor) return _monitor;
  const all = Monitor.all();
  if (!all.length) throw new Error("No monitor via node-screenshots");
  _monitor = all[0];
  return _monitor;
}

export function captureImageOnly() {
  return getMonitor().captureImage();
}
export function readback(image) {
  return image.toRaw();
}

export async function getRawFrame() {
  if (_frame) return _frame;
  const image = await captureImageOnly();
  const buffer = await readback(image);
  _frame = { buffer, width: image.width, height: image.height, channels: 4 };
  return _frame;
}

// Pure stats on an array of ms samples (also exported for unit testing).
export function benchStats(xs) {
  const a = xs.slice().sort((p, q) => p - q);
  return {
    median: a[a.length >> 1],
    min: a[0],
    max: a[a.length - 1],
    mean: xs.reduce((s, v) => s + v, 0) / xs.length
  };
}

export async function bench(name, fn, { warmup = DEFAULT_WARMUP, samples = DEFAULT_SAMPLES } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const xs = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    await fn();
    xs.push(performance.now() - t);
  }
  return { name, samples: xs, ...benchStats(xs) };
}

export const fmt = (n, w = 7) =>
  (typeof n === "number" ? n.toFixed(1) : String(n)).padStart(w);

export function printRows(rows) {
  const W = [42, 9, 9, 9];
  const header = ["algorithm", "median", "min", "mean"].map((h, i) => h.padEnd(W[i])).join("  ").trimEnd();
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log([r.name.padEnd(W[0]), fmt(r.median, W[1]), fmt(r.min, W[2]), fmt(r.mean, W[3])].join("  "));
  }
}
