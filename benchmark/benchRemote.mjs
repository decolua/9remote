#!/usr/bin/env node
// Benchmark: JS vs WASM (AssemblyScript) for remote hot-path functions.
// Functions: calculateTileChecksum, bgraToRgbaInPlace, encodeTileBinary.
// Usage: node benchRemote.mjs

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────────────────────
const CFG = {
  frameWidth: 1920,
  frameHeight: 1080,
  tileSize: 128,
  sampleStep: 16,
  tileJpegSize: 10 * 1024,
  iters: {
    checksum: 100_000,
    bgra: 1_000,
    encode: 100_000
  }
};

// ─── AssemblyScript source (raw pointer API, no managed runtime) ────────────
const AS_SOURCE = `
// All functions operate on raw linear memory via pointers (usize).
// Caller pre-copies data into wasm memory and passes offsets.

export function calculateTileChecksum(
  bufPtr: usize,
  width: i32,
  channels: i32,
  startX: i32,
  startY: i32,
  tileWidth: i32,
  tileHeight: i32,
  sampleStep: i32
): u32 {
  let sum: u32 = 0;
  const rowBytes = width * channels;
  for (let y: i32 = 0; y < tileHeight; y += 4) {
    const rowOffset = (startY + y) * rowBytes + startX * channels;
    for (let x: i32 = 0; x < tileWidth; x += sampleStep) {
      const o = <usize>(rowOffset + x * channels);
      sum += <u32>load<u8>(bufPtr + o);
      sum ^= <u32>load<u8>(bufPtr + o + 1);
      sum += (<u32>load<u8>(bufPtr + o + 2)) << 1;
      sum ^= (<u32>load<u8>(bufPtr + o + 3)) << 2;
    }
  }
  return sum;
}

// Swap R<->B on Uint32 words in-place
export function bgraToRgba(ptr: usize, wordCount: i32): void {
  for (let i: i32 = 0; i < wordCount; i++) {
    const addr = ptr + (<usize>i << 2);
    const p = load<u32>(addr);
    store<u32>(addr, (p & 0xff00ff00) | ((p & 0x00ff0000) >> 16) | ((p & 0x000000ff) << 16));
  }
}

// Write 24-byte header (6 × u32 little-endian) at ptr+offset
export function encodeTileHeader(
  ptr: usize,
  tileIndex: u32,
  x: u32,
  y: u32,
  w: u32,
  h: u32,
  jpegLen: u32
): void {
  store<u32>(ptr, tileIndex);
  store<u32>(ptr + 4, x);
  store<u32>(ptr + 8, y);
  store<u32>(ptr + 12, w);
  store<u32>(ptr + 16, h);
  store<u32>(ptr + 20, jpegLen);
}
`;

// ─── JS reference implementations (copy from agent source) ──────────────────
function jsCalculateTileChecksum(buf, width, channels, startX, startY, tileW, tileH, step) {
  let sum = 0;
  const rowBytes = width * channels;
  for (let y = 0; y < tileH; y += 4) {
    const rowOffset = (startY + y) * rowBytes + startX * channels;
    for (let x = 0; x < tileW; x += step) {
      const o = rowOffset + x * channels;
      sum += buf[o] || 0;
      sum ^= buf[o + 1] || 0;
      sum += (buf[o + 2] || 0) << 1;
      sum ^= (buf[o + 3] || 0) << 2;
    }
  }
  return sum >>> 0;
}

function jsBgraToRgbaInPlace(buf) {
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  for (let i = 0; i < u32.length; i++) {
    const p = u32[i];
    u32[i] = (p & 0xff00ff00) | ((p & 0x00ff0000) >> 16) | ((p & 0x000000ff) << 16);
  }
}

function jsEncodeTileBinary(tile) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(tile.tileIndex, 0);
  header.writeUInt32LE(tile.x, 4);
  header.writeUInt32LE(tile.y, 8);
  header.writeUInt32LE(tile.width, 12);
  header.writeUInt32LE(tile.height, 16);
  header.writeUInt32LE(tile.imageBuffer.length, 20);
  return Buffer.concat([header, tile.imageBuffer]);
}

// ─── WASM compile & load ────────────────────────────────────────────────────
async function compileWasm() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-wasm-"));
  const srcFile = path.join(tmpDir, "mod.ts");
  const outFile = path.join(tmpDir, "mod.wasm");
  fs.writeFileSync(srcFile, AS_SOURCE);

  console.log("🔧 Compiling AssemblyScript → WASM (optimized)...");
  try {
    execSync(
      `npx --yes -p assemblyscript asc "${srcFile}" -o "${outFile}" -O3 --runtime stub --initialMemory 64`,
      { stdio: "inherit", cwd: __dirname }
    );
  } catch (e) {
    console.error("❌ AssemblyScript compile failed.");
    throw e;
  }

  const wasmBytes = fs.readFileSync(outFile);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: {
      abort: () => { throw new Error("wasm abort"); }
    }
  });
  return instance.exports;
}

// ─── Bench harness ──────────────────────────────────────────────────────────
function bench(iters, fn) {
  // Warmup
  for (let i = 0; i < Math.min(iters, 1000); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const t1 = performance.now();
  return { iters, ms: t1 - t0, opsPerSec: (iters / (t1 - t0)) * 1000 };
}

function fmt(n) { return n.toLocaleString("en-US", { maximumFractionDigits: 2 }); }

function printTable(rows) {
  const head = ["Function", "JS (ms)", "WASM (ms)", "JS ops/s", "WASM ops/s", "Speedup"];
  const widths = [30, 12, 12, 16, 16, 12];
  const line = (cells) => "│ " + cells.map((c, i) => String(c).padEnd(widths[i])).join(" │ ") + " │";
  const sep = "├" + widths.map(w => "─".repeat(w + 2)).join("┼") + "┤";
  const top = "┌" + widths.map(w => "─".repeat(w + 2)).join("┬") + "┐";
  const bot = "└" + widths.map(w => "─".repeat(w + 2)).join("┴") + "┘";

  console.log("\n" + top);
  console.log(line(head));
  console.log(sep);
  for (const r of rows) {
    const ratio = r.js.ms / r.wasm.ms;
    const mark = ratio >= 1.1 ? "✅" : ratio <= 0.9 ? "❌" : "≈";
    console.log(line([
      r.name,
      fmt(r.js.ms),
      fmt(r.wasm.ms),
      fmt(r.js.opsPerSec),
      fmt(r.wasm.opsPerSec),
      `${ratio.toFixed(2)}x ${mark}`
    ]));
  }
  console.log(bot);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const wasm = await compileWasm();

  const frameBytes = CFG.frameWidth * CFG.frameHeight * 4;
  const pageSize = 65536;
  const neededPages = Math.ceil((frameBytes + 65536) / pageSize);
  const currentPages = wasm.memory.buffer.byteLength / pageSize;
  if (currentPages < neededPages) wasm.memory.grow(neededPages - currentPages);

  // Fake 1920x1080 BGRA screen buffer
  const screenBuf = Buffer.alloc(frameBytes);
  for (let i = 0; i < frameBytes; i++) screenBuf[i] = (i * 31) & 0xff;

  const fakeTile = {
    tileIndex: 42,
    x: 256,
    y: 128,
    width: CFG.tileSize,
    height: CFG.tileSize,
    imageBuffer: Buffer.alloc(CFG.tileJpegSize, 0xab)
  };

  // Layout in wasm memory:
  //   [0 .. frameBytes)           → frame buffer
  //   [frameBytes .. +64]          → header scratch area
  const FRAME_PTR = 0;
  const HDR_PTR = frameBytes;
  new Uint8Array(wasm.memory.buffer, FRAME_PTR, frameBytes).set(screenBuf);

  // Verify correctness once (JS vs WASM) before bench
  const jsSum = jsCalculateTileChecksum(screenBuf, CFG.frameWidth, 4, 256, 128, CFG.tileSize, CFG.tileSize, CFG.sampleStep);
  const wasmSum = wasm.calculateTileChecksum(FRAME_PTR, CFG.frameWidth, 4, 256, 128, CFG.tileSize, CFG.tileSize, CFG.sampleStep) >>> 0;
  if (jsSum !== wasmSum) {
    console.warn(`⚠️  Checksum mismatch: js=${jsSum} wasm=${wasmSum} (continuing anyway)`);
  } else {
    console.log(`✓ Checksum match: ${jsSum}`);
  }

  // ── Bench 1: calculateTileChecksum ──────────────────────────────────────
  const checksumJs = bench(CFG.iters.checksum, () => {
    jsCalculateTileChecksum(screenBuf, CFG.frameWidth, 4, 256, 128, CFG.tileSize, CFG.tileSize, CFG.sampleStep);
  });
  const checksumWasm = bench(CFG.iters.checksum, () => {
    wasm.calculateTileChecksum(FRAME_PTR, CFG.frameWidth, 4, 256, 128, CFG.tileSize, CFG.tileSize, CFG.sampleStep);
  });

  // ── Bench 2: bgraToRgbaInPlace (full frame) ─────────────────────────────
  const jsFrame = Buffer.from(screenBuf);
  const bgraJs = bench(CFG.iters.bgra, () => {
    jsBgraToRgbaInPlace(jsFrame);
  });
  // Reset wasm frame each call would skew result — swap is idempotent over pairs,
  // but timing is dominated by loop cost either way.
  const wordCount = frameBytes >> 2;
  const bgraWasm = bench(CFG.iters.bgra, () => {
    wasm.bgraToRgba(FRAME_PTR, wordCount);
  });

  // ── Bench 3: encodeTileBinary ───────────────────────────────────────────
  const encJs = bench(CFG.iters.encode, () => {
    jsEncodeTileBinary(fakeTile);
  });
  // Equivalent wasm work: write 24B header in wasm + JS Buffer.concat with JPEG
  const headerView = Buffer.from(wasm.memory.buffer, HDR_PTR, 24);
  const encWasm = bench(CFG.iters.encode, () => {
    wasm.encodeTileHeader(HDR_PTR, fakeTile.tileIndex, fakeTile.x, fakeTile.y,
      fakeTile.width, fakeTile.height, fakeTile.imageBuffer.length);
    Buffer.concat([headerView, fakeTile.imageBuffer]);
  });

  // ─── Print ─────────────────────────────────────────────────────────────
  console.log(`\n📊 Benchmark: JS vs WASM (AssemblyScript)`);
  console.log(`   Frame: ${CFG.frameWidth}x${CFG.frameHeight} BGRA, tile ${CFG.tileSize}², sampleStep ${CFG.sampleStep}`);
  console.log(`   Iters: checksum=${CFG.iters.checksum}, bgra=${CFG.iters.bgra}, encode=${CFG.iters.encode}`);

  printTable([
    { name: "calculateTileChecksum", js: checksumJs, wasm: checksumWasm },
    { name: "bgraToRgbaInPlace", js: bgraJs, wasm: bgraWasm },
    { name: "encodeTileBinary", js: encJs, wasm: encWasm }
  ]);

  console.log("\nLegend: ✅ WASM faster (≥1.1×)  ≈ similar  ❌ WASM slower (≤0.9×)\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
