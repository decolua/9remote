// Batch size optimization benchmark — find optimal KB/batch for tile streaming.
// Real measurement: concat (encodeTilesBatch) + sharp decode cost.
// Modeled: per-message transport overhead + head-of-line blocking delay
// (constants from WebRTC SCTP literature — see report).
//
// Run: node agent/benchmark/batchSizeOptimal.mjs

import sharp from "sharp";
import { performance } from "perf_hooks";

// === Config =============================================================
const QUALITY = 50;
const EFFORT = 0;
const CHANNELS = 4;
const WIRE_HEADER = 28;   // per-tile
const WIRE_BATCH = 12;    // per-batch
const SCTP_MAX = 65536;   // SCTP reassembly default (safe ceiling)
const ITERATIONS = 50;
const WARMUP = 5;

// Modeled transport constants (from search data)
// SCTP per-message overhead: send syscall + DTLS framing + ack bookkeeping.
const PER_MSG_OVERHEAD_MS = 0.15;
// Head-of-line blocking: a message monopolizes the SCTP association while in flight.
// Larger message = longer monopoly = blocks other frames/messages.
// Linear model: ~batchKB * factor. Calibrated so 64KB ~ several ms HOL at typical RTT.
const HOL_MS_PER_KB = 0.08;

const SCREEN_W = 960;
const SCREEN_H = 540;

// Tile configs to test
const TILE_CONFIGS = [
  { name: "tile-64",  w: 64,  h: 64,  count: Math.ceil(SCREEN_W / 64)  * Math.ceil(SCREEN_H / 64)  }, // 135
  { name: "tile-128", w: 128, h: 128, count: Math.ceil(SCREEN_W / 128) * Math.ceil(SCREEN_H / 128) }, // 40
  { name: "tile-256", w: 256, h: 256, count: Math.ceil(SCREEN_W / 256) * Math.ceil(SCREEN_H / 256) }, // 12
];

// Target batch sizes to sweep (KB)
const BATCH_TARGETS_KB = [4, 8, 16, 24, 32, 48, 64];

// === Helpers ============================================================
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Generate a realistic WebP-encoded tile (gradient + UI overlay).
async function genTile(w, h, seed) {
  const raw = Buffer.alloc(w * h * CHANNELS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * CHANNELS;
      const r = 128 + 60 * Math.sin((x + seed) * 0.05) * Math.cos((y + seed) * 0.05);
      const g = 100 + 40 * Math.cos((x + seed) * 0.03 + (y + seed) * 0.04);
      const b = 140 + 50 * Math.sin((x + y + seed) * 0.04);
      const noise = ((x * 7919 + y * 6151 + seed) % 7) - 3;
      raw[i] = clamp(r + noise);
      raw[i + 1] = clamp(g + noise);
      raw[i + 2] = clamp(b + noise);
      raw[i + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: CHANNELS } })
    .webp({ quality: QUALITY, effort: EFFORT }).toBuffer();
}

// Mirror encodeTilesBatch: [12B header][N × (28B header + webp)]
function concatBatch(chunk) {
  const header = Buffer.alloc(WIRE_BATCH + chunk.length * WIRE_HEADER);
  header.writeUInt32LE(chunk.length, 0);
  return Buffer.concat([header, ...chunk]);
}

async function decodeBatch(buf) {
  // Simulate client decode: skip parsing, just decode each webp in the batch.
  // For cost purposes we decode one tile per batch (browser GPU is parallel —
  // sharp single-thread is a pessimistic upper bound).
  // To keep timing stable, decode a representative tile of the same size.
  return buf; // actual decode cost measured separately per-tile below
}

async function timeAsync(fn) {
  const t0 = performance.now();
  const out = await fn();
  return { ms: performance.now() - t0, out };
}

const fmt = (n, d = 2) => (typeof n === "number" ? n.toFixed(d) : String(n));

// === Main ===============================================================
async function main() {
  console.log("\n# Batch size optimization — screen " + SCREEN_W + "x" + SCREEN_H + ", WebP q" + QUALITY + " effort " + EFFORT);
  console.log("# Modeled: per-msg overhead = " + PER_MSG_OVERHEAD_MS + " ms, HOL = " + HOL_MS_PER_KB + " ms/KB\n");

  // Pre-generate tiles for each config
  const tilesets = [];
  for (const cfg of TILE_CONFIGS) {
    const tiles = [];
    for (let i = 0; i < cfg.count; i++) tiles.push(await genTile(cfg.w, cfg.h, i));
    const avgBytes = tiles.reduce((s, t) => s + t.length, 0) / tiles.length;
    tilesets.push({ cfg, tiles, avgBytes });
    console.log(`# ${cfg.name}: ${cfg.count} tiles, avg ${avgBytes.toFixed(0)} B/tile`);
  }
  console.log("");

  // Pre-decode one tile per config to measure decode cost
  const decodeCost = {};
  for (const ts of tilesets) {
    let decMs = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      await sharp(ts.tiles[0]).raw().toBuffer();
      decMs += performance.now() - t0;
    }
    decodeCost[ts.cfg.name] = decMs / ITERATIONS;
  }

  const results = [];

  for (const ts of tilesets) {
    const { cfg, tiles, avgBytes } = ts;
    const totalBytesFull = tiles.reduce((s, t) => s + t.length + WIRE_HEADER, 0) + WIRE_BATCH;

    for (const targetKB of BATCH_TARGETS_KB) {
      const targetBytes = targetKB * 1024;
      // tiles per batch given target KB
      const tilesPerBatch = Math.max(1, Math.floor((targetBytes - WIRE_BATCH) / (avgBytes + WIRE_HEADER)));
      // Cap by SCTP hard ceiling — if a single batch would exceed 64KB, shrink
      const sctpCap = Math.max(1, Math.floor((SCTP_MAX - WIRE_BATCH) / (avgBytes + WIRE_HEADER)));
      const chunkSize = Math.min(tilesPerBatch, sctpCap, tiles.length);
      const messages = Math.ceil(tiles.length / chunkSize);
      const actualBatchKB = ((chunkSize * (avgBytes + WIRE_HEADER) + WIRE_BATCH) / 1024);

      // Real: concat cost
      for (let i = 0; i < WARMUP; i++) concatBatch(tiles.slice(0, chunkSize));
      let concatMs = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        for (let m = 0; m < messages; m++) {
          const chunk = tiles.slice(m * chunkSize, Math.min((m + 1) * chunkSize, tiles.length));
          concatBatch(chunk);
        }
        concatMs += performance.now() - t0;
      }
      concatMs /= ITERATIONS;

      // Real: decode cost (all tiles, browser-parallel upper bound via sharp single)
      const decodeMs = decodeCost[cfg.name] * tiles.length;

      // Modeled: transport overhead
      const transportMs = messages * PER_MSG_OVERHEAD_MS;
      const holMs = actualBatchKB * HOL_MS_PER_KB;

      const totalMs = concatMs + decodeMs + transportMs + holMs;

      results.push({
        tile: cfg.name,
        avgBytes,
        tilesTotal: tiles.length,
        totalKBFull: totalBytesFull / 1024,
        targetKB,
        chunkSize,
        messages,
        actualBatchKB,
        concatMs,
        decodeMs,
        transportMs,
        holMs,
        totalMs,
      });
    }
  }

  printReport(results);
}

function printReport(rows) {
  for (const cfg of TILE_CONFIGS) {
    console.log("## " + cfg.name + " — full-screen change, vary batch target\n");
    console.log("| target KB | tiles/batch | msgs | actual KB/batch | concat ms | decode ms | transport ms | HOL ms | total ms |");
    console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    const sub = rows.filter(r => r.tile === cfg.name);
    let best = null;
    for (const r of sub) {
      console.log(`| ${r.targetKB} | ${r.chunkSize} | ${r.messages} | ${fmt(r.actualBatchKB, 1)} | ${fmt(r.concatMs)} | ${fmt(r.decodeMs)} | ${fmt(r.transportMs)} | ${fmt(r.holMs)} | ${fmt(r.totalMs)} |`);
      if (!best || r.totalMs < best.totalMs) best = r;
    }
    console.log(`\n**Best for ${cfg.name}: target ${best.targetKB}KB → ${fmt(best.actualBatchKB,1)}KB/batch, ${best.messages} msgs, total ${fmt(best.totalMs)}ms**\n`);
  }

  console.log("## Cross-config summary — best target per tile size\n");
  console.log("| tile | best target KB | actual KB/batch | msgs | total ms |");
  console.log("|---|---:|---:|---:|---:|");
  for (const cfg of TILE_CONFIGS) {
    const sub = rows.filter(r => r.tile === cfg.name);
    const best = sub.reduce((a, b) => a.totalMs < b.totalMs ? a : b);
    console.log(`| ${cfg.name} | ${best.targetKB} | ${fmt(best.actualBatchKB, 1)} | ${best.messages} | ${fmt(best.totalMs)} |`);
  }

  console.log("\n## Notes");
  console.log("- concat ms: real Buffer.concat cost (agent-side encodeTilesBatch).");
  console.log("- decode ms: real sharp decode cost × tile count (pessimistic — browser createImageBitmap is GPU-parallel, so actual client decode is lower).");
  console.log("- transport ms: modeled messages × " + PER_MSG_OVERHEAD_MS + "ms (SCTP send + DTLS framing + ack bookkeeping).");
  console.log("- HOL ms: modeled batch KB × " + HOL_MS_PER_KB + "ms/KB (head-of-line blocking — a large message monopolizes the SCTP association).");
  console.log("- SCTP hard ceiling: 64KB (reassembly default). tile-256 packs fewer per batch because each tile is bigger.");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
