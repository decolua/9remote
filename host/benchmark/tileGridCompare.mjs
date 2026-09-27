// Grid strategy benchmark — tileSize 128 (baseline) vs tileSize 64 (uniform) vs quadtree on 128.
// Screen-level: measures full-screen checksum cost (the real differentiator),
// not just the changed region. Static tiles count too.
//
// Run: node agent/benchmark/tileGridCompare.mjs

import sharp from "sharp";
import { performance } from "perf_hooks";

// === Config =============================================================
const SCREEN_W = 960;
const SCREEN_H = 540;
const CHANNELS = 4;
const QUALITY = 50;
const EFFORT = 0;
const WIRE_HEADER = 28;
const WIRE_BATCH = 12;
const ITERATIONS = 20;
const WARMUP = 3;
const ROW_STEP = 3;
const COL_STEP = 8;

// === Helpers ============================================================
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function generateScreen(w, h) {
  const buf = Buffer.alloc(w * h * CHANNELS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * CHANNELS;
      const r = 128 + 60 * Math.sin(x * 0.03) * Math.cos(y * 0.04);
      const g = 100 + 40 * Math.cos(x * 0.025 + y * 0.03);
      const b = 140 + 50 * Math.sin((x + y) * 0.03);
      const inButton = x < 200 && y < 80;
      const textEdge = x % 9 === 0 && y > 10 && y < 80 ? 80 : 0;
      const noise = ((x * 7919 + y * 6151) % 7) - 3;
      buf[i] = clamp(r + noise + (inButton ? -40 : 0) + textEdge);
      buf[i + 1] = clamp(g + noise + (inButton ? 30 : 0) + textEdge);
      buf[i + 2] = clamp(b + noise + (inButton ? -20 : 0) + textEdge);
      buf[i + 3] = 255;
    }
  }
  return buf;
}

// Tile/checksum over [startX, startX+tw) × [startY, startY+th) using sheared grid.
function checksumRegion(buf, screenW, startX, startY, tw, th) {
  let sum = 0;
  for (let y = 0; y < th; y += ROW_STEP) {
    const ox = ((y / ROW_STEP) | 0) % COL_STEP;
    const rowOffset = (startY + y) * screenW * CHANNELS + (startX + ox) * CHANNELS;
    for (let x = ox; x < tw; x += COL_STEP) {
      const offset = rowOffset + (x - ox) * CHANNELS;
      const wt = x + 1;
      sum = (sum + buf[offset] * wt) >>> 0;
      sum ^= buf[offset + 1] << 1;
      sum = (sum + buf[offset + 2] * wt) >>> 0;
      sum ^= buf[offset + 3] << 2;
    }
  }
  return sum >>> 0;
}

function fillRect(buf, w, x0, y0, rw, rh, r, g, b) {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * w + x) * CHANNELS;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
}

// Quadrant bounds inside a tile (for quadtree).
function quadBoundsInTile(q, tw, th) {
  const halfW = Math.floor(tw / 2);
  const halfH = Math.floor(th / 2);
  const x0 = (q % 2) * halfW;
  const y0 = Math.floor(q / 2) * halfH;
  const w = Math.min(halfW, tw - x0);
  const h = Math.min(halfH, th - y0);
  return { x0, y0, w, h };
}

// === Change patterns (screen-level) =====================================
// Each returns list of changed rects {x,y,w,h} for ground-truth area%.
const PATTERNS = [
  {
    name: "idle (no change)",
    apply: () => ({ rects: [], areaPct: 0 }),
  },
  {
    name: "cursor 16x16 (~0.05%)",
    apply: (buf) => {
      fillRect(buf, SCREEN_W, 400, 200, 16, 16, 240, 240, 240);
      return { rects: [{ x: 400, y: 200, w: 16, h: 16 }], areaPct: (16 * 16) / (SCREEN_W * SCREEN_H) * 100 };
    },
  },
  {
    name: "notification 40x40 (~0.3%)",
    apply: (buf) => {
      fillRect(buf, SCREEN_W, 700, 400, 40, 40, 200, 120, 40);
      return { rects: [{ x: 700, y: 400, w: 40, h: 40 }], areaPct: (40 * 40) / (SCREEN_W * SCREEN_H) * 100 };
    },
  },
  {
    name: "text caret band (~1%)",
    apply: (buf) => {
      // Editor area: 2px vertical caret + small text line change
      for (let y = 250; y < 290; y++) {
        for (let x = 300; x < 304; x++) {
          const i = (y * SCREEN_W + x) * CHANNELS;
          buf[i] = 30; buf[i + 1] = 30; buf[i + 2] = 30;
        }
      }
      fillRect(buf, SCREEN_W, 310, 252, 80, 4, 200, 200, 200);
      return { rects: [{ x: 300, y: 250, w: 90, h: 40 }], areaPct: (90 * 40) / (SCREEN_W * SCREEN_H) * 100 };
    },
  },
  {
    name: "scroll bottom half (~50%)",
    apply: (buf) => {
      const half = Math.floor(SCREEN_H / 2);
      for (let y = 0; y < half; y++) {
        for (let x = 0; x < SCREEN_W; x++) {
          const srcY = y + half;
          const i = (y * SCREEN_W + x) * CHANNELS;
          const s = (srcY * SCREEN_W + x) * CHANNELS;
          buf[i] = buf[s]; buf[i + 1] = buf[s + 1]; buf[i + 2] = buf[s + 2];
        }
      }
      return { rects: [{ x: 0, y: 0, w: SCREEN_W, h: half }], areaPct: 50 };
    },
  },
  {
    name: "full change (100%)",
    apply: (buf) => {
      for (let i = 0; i < buf.length; i += CHANNELS) {
        buf[i] = 200 - buf[i];
        buf[i + 1] = 200 - buf[i + 1];
        buf[i + 2] = 200 - buf[i + 2];
      }
      return { rects: [{ x: 0, y: 0, w: SCREEN_W, h: SCREEN_H }], areaPct: 100 };
    },
  },
];

// === Strategies =========================================================
// Each returns: { checksumMs, encodeMs, wireBytes, regionsSent, hashEntries }
// Pre-conditions: prevBuf and curBuf are full-screen RGBA.

async function encodeWebp(buf, w, h) {
  return sharp(buf, { raw: { width: w, height: h, channels: CHANNELS } })
    .webp({ quality: QUALITY, effort: EFFORT }).toBuffer();
}

function extractRegion(srcBuf, screenW, startX, startY, rw, rh) {
  const out = Buffer.alloc(rw * rh * CHANNELS);
  for (let y = 0; y < rh; y++) {
    srcBuf.copy(out, y * rw * CHANNELS,
      (startY + y) * screenW * CHANNELS + startX * CHANNELS,
      (startY + y) * screenW * CHANNELS + (startX + rw) * CHANNELS);
  }
  return out;
}

// Strategy A: baseline grid (tileSize as configured).
async function strategyGrid(prevBuf, curBuf, tileSize) {
  const cols = Math.ceil(SCREEN_W / tileSize);
  const rows = Math.ceil(SCREEN_H / tileSize);
  const hashEntries = cols * rows;

  // 1) checksum all tiles
  const t0 = performance.now();
  const changed = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * tileSize;
      const y = r * tileSize;
      const tw = Math.min(tileSize, SCREEN_W - x);
      const th = Math.min(tileSize, SCREEN_H - y);
      const cur = checksumRegion(curBuf, SCREEN_W, x, y, tw, th);
      const prv = checksumRegion(prevBuf, SCREEN_W, x, y, tw, th);
      if (cur !== prv) changed.push({ x, y, w: tw, h: th });
    }
  }
  const checksumMs = performance.now() - t0;

  // 2) encode changed tiles
  const t1 = performance.now();
  let wireBytes = 0;
  for (const t of changed) {
    const region = extractRegion(curBuf, SCREEN_W, t.x, t.y, t.w, t.h);
    const webp = await encodeWebp(region, t.w, t.h);
    wireBytes += WIRE_HEADER + webp.length;
  }
  if (changed.length) wireBytes += WIRE_BATCH;
  const encodeMs = performance.now() - t1;

  return { checksumMs, encodeMs, wireBytes, regionsSent: changed.length, hashEntries };
}

// Strategy B: quadtree on 128 — tile-level checksum, then quadrant-level on changed tiles.
async function strategyQuadtree(prevBuf, curBuf) {
  const tileSize = 128;
  const cols = Math.ceil(SCREEN_W / tileSize);
  const rows = Math.ceil(SCREEN_H / tileSize);
  const hashEntries = cols * rows; // tile-level hash only

  // 1) tile-level checksum (coarse) → find changed tiles
  const t0 = performance.now();
  const changedTiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * tileSize;
      const y = r * tileSize;
      const tw = Math.min(tileSize, SCREEN_W - x);
      const th = Math.min(tileSize, SCREEN_H - y);
      const cur = checksumRegion(curBuf, SCREEN_W, x, y, tw, th);
      const prv = checksumRegion(prevBuf, SCREEN_W, x, y, tw, th);
      if (cur !== prv) changedTiles.push({ x, y, w: tw, h: th });
    }
  }

  // 2) for each changed tile, quadrant-level checksum → find changed quadrants
  const changedQuads = []; // {x,y,w,h}
  for (const tile of changedTiles) {
    for (let q = 0; q < 4; q++) {
      const qb = quadBoundsInTile(q, tile.w, tile.h);
      const qx = tile.x + qb.x0;
      const qy = tile.y + qb.y0;
      const cur = checksumRegion(curBuf, SCREEN_W, qx, qy, qb.w, qb.h);
      const prv = checksumRegion(prevBuf, SCREEN_W, qx, qy, qb.w, qb.h);
      if (cur !== prv) changedQuads.push({ x: qx, y: qy, w: qb.w, h: qb.h });
    }
  }
  const checksumMs = performance.now() - t0;

  // 3) encode changed quadrants
  const t1 = performance.now();
  let wireBytes = 0;
  for (const q of changedQuads) {
    const region = extractRegion(curBuf, SCREEN_W, q.x, q.y, q.w, q.h);
    const webp = await encodeWebp(region, q.w, q.h);
    wireBytes += WIRE_HEADER + webp.length;
  }
  if (changedQuads.length) wireBytes += WIRE_BATCH;
  const encodeMs = performance.now() - t1;

  return { checksumMs, encodeMs, wireBytes, regionsSent: changedQuads.length, hashEntries };
}

// === Runner =============================================================
async function timeAsync(fn) {
  const t0 = performance.now();
  const out = await fn();
  return { ms: performance.now() - t0, out };
}

const fmt = (n, d = 2) => (typeof n === "number" ? n.toFixed(d) : String(n));

async function runStrategy(name, fn, prevBuf, curBuf) {
  for (let i = 0; i < WARMUP; i++) await fn(prevBuf, curBuf);
  let cMs = 0, eMs = 0, wire = 0, regions = 0, hashes = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const r = await fn(prevBuf, curBuf);
    cMs += r.checksumMs;
    eMs += r.encodeMs;
    wire = r.wireBytes;
    regions = r.regionsSent;
    hashes = r.hashEntries;
  }
  return {
    strategy: name,
    checksumMs: cMs / ITERATIONS,
    encodeMs: eMs / ITERATIONS,
    wireBytes: wire,
    regionsSent: regions,
    hashEntries: hashes,
    totalMs: (cMs + eMs) / ITERATIONS,
  };
}

async function main() {
  const prevBuf = generateScreen(SCREEN_W, SCREEN_H);
  const results = [];

  for (const pat of PATTERNS) {
    const curBuf = Buffer.from(prevBuf);
    const { areaPct } = pat.apply(curBuf);

    const a = await runStrategy("baseline-128", (p, c) => strategyGrid(p, c, 128), prevBuf, curBuf);
    const b = await runStrategy("grid-64",     (p, c) => strategyGrid(p, c, 64),   prevBuf, curBuf);
    const c = await runStrategy("quadtree-128", (p, cc) => strategyQuadtree(p, cc),  prevBuf, curBuf);

    results.push({ pattern: pat.name, areaPct, baseline: a, grid64: b, quadtree: c });
  }

  printReport(results);
}

function pct(num, base) {
  if (!base) return "—";
  return (((num - base) / base) * 100).toFixed(0) + "%";
}

function printReport(rows) {
  console.log("\n# Grid strategy benchmark — screen " + SCREEN_W + "x" + SCREEN_H + ", WebP q" + QUALITY + " effort " + EFFORT + ", " + ITERATIONS + " iters\n");

  console.log("## Per-pattern — checksum (full screen) + wire bytes + regions sent\n");
  console.log("| pattern | area% | strategy | checksum ms | encode ms | wire bytes | regions sent | hash entries |");
  console.log("|---|---:|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    for (const s of [r.baseline, r.grid64, r.quadtree]) {
      console.log(`| ${r.pattern} | ${r.areaPct.toFixed(2)} | ${s.strategy} | ${fmt(s.checksumMs)} | ${fmt(s.encodeMs)} | ${s.wireBytes} | ${s.regionsSent} | ${s.hashEntries} |`);
    }
    console.log("|  |  |  |  |  |  |  |  |");
  }

  console.log("\n## Wire bytes vs baseline-128\n");
  console.log("| pattern | area% | grid-64 | quadtree-128 |");
  console.log("|---|---:|:--|:--|");
  for (const r of rows) {
    console.log(`| ${r.pattern} | ${r.areaPct.toFixed(2)} | ${pct(r.grid64.wireBytes, r.baseline.wireBytes)} | ${pct(r.quadtree.wireBytes, r.baseline.wireBytes)} |`);
  }

  console.log("\n## Checksum CPU vs baseline-128 (the real differentiator — runs every frame over full screen)\n");
  console.log("| pattern | area% | grid-64 | quadtree-128 |");
  console.log("|---|---:|:--|:--|");
  for (const r of rows) {
    console.log(`| ${r.pattern} | ${r.areaPct.toFixed(2)} | ${pct(r.grid64.checksumMs, r.baseline.checksumMs)} | ${pct(r.quadtree.checksumMs, r.baseline.checksumMs)} |`);
  }

  // Aggregate: uniform mix
  console.log("\n## Aggregate — uniform mix across all " + rows.length + " patterns\n");
  const sum = (key) => rows.reduce((acc, r) => {
    acc.baseline += r.baseline[key];
    acc.grid64 += r.grid64[key];
    acc.quadtree += r.quadtree[key];
    return acc;
  }, { baseline: 0, grid64: 0, quadtree: 0 });
  const tw = sum("wireBytes"), tc = sum("checksumMs"), te = sum("encodeMs"), tr = sum("regionsSent");
  console.log("| metric | baseline-128 | grid-64 (vs base) | quadtree-128 (vs base) |");
  console.log("|---|---:|---:|---:|");
  console.log(`| Σ wire bytes | ${tw.baseline} | ${tw.grid64} (${pct(tw.grid64, tw.baseline)}) | ${tw.quadtree} (${pct(tw.quadtree, tw.baseline)}) |`);
  console.log(`| Σ checksum ms | ${fmt(tc.baseline)} | ${fmt(tc.grid64)} (${pct(tc.grid64, tc.baseline)}) | ${fmt(tc.quadtree)} (${pct(tc.quadtree, tc.baseline)}) |`);
  console.log(`| Σ encode ms | ${fmt(te.baseline)} | ${fmt(te.grid64)} (${pct(te.grid64, te.baseline)}) | ${fmt(te.quadtree)} (${pct(te.quadtree, te.baseline)}) |`);
  console.log(`| Σ regions sent | ${tr.baseline} | ${tr.grid64} | ${tr.quadtree} |`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
