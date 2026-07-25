// Tile encode strategy benchmark — baseline (full tile) vs quadtree (4 sub-regions) vs mask (dirty bitmask).
// Synthetic RGBA image that mimics real desktop content (gradient photo + UI + text edges + texture).
// Runs N iterations per (strategy × pattern) and prints comparative tables.
//
// Run: node agent/benchmark/tileStrategy.mjs

import sharp from "sharp";
import { performance } from "perf_hooks";

// === Config (mirror REMOTE_CONFIG.pipeline) =============================
const TILE = 128;
const QUAD = TILE / 2; // 64 — quadrant size
const CHANNELS = 4;
const QUALITY = 50;
const EFFORT = 0; // WebP effort
const WIRE_HEADER = 28; // per-tile wire header (encodeTileBinary v2)
const WIRE_BATCH = 12; // per-chunk batch header
const WIRE_MASK = 1; // 4-bit dirty mask, 1 byte
const ITERATIONS = 30; // encode samples per (strategy × pattern)
const WARMUP = 3;

// Sheared-grid sampling (mirror TileManager.calculateTileChecksumDirect)
const ROW_STEP = 3;
const COL_STEP = 8;

// === Helpers ============================================================
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Synthetic baseline image — desktop-like content, not random noise.
function generateBaseline(width, height) {
  const buf = Buffer.alloc(width * height * CHANNELS);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * CHANNELS;
      // Photo-like smooth gradient (compresses well)
      const r = 128 + 60 * Math.sin(x * 0.05) * Math.cos(y * 0.05);
      const g = 100 + 40 * Math.cos(x * 0.03 + y * 0.04);
      const b = 140 + 50 * Math.sin((x + y) * 0.04);
      // UI overlay: rounded button top-left
      const inButton = x < 60 && y < 30;
      // Text-like high-freq vertical strokes
      const textEdge = x % 8 === 0 && y > 8 && y < 30 ? 80 : 0;
      // Subtle texture noise
      const noise = ((x * 7919 + y * 6151) % 7) - 3;
      buf[i] = clamp(r + noise + (inButton ? -40 : 0) + textEdge);
      buf[i + 1] = clamp(g + noise + (inButton ? 30 : 0) + textEdge);
      buf[i + 2] = clamp(b + noise + (inButton ? -20 : 0) + textEdge);
      buf[i + 3] = 255;
    }
  }
  return buf;
}

function copyBuf(src) {
  return Buffer.from(src);
}

// Quadrant index layout: 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right
function quadBounds(q, width, height) {
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  const x0 = (q % 2) * halfW;
  const y0 = Math.floor(q / 2) * halfH;
  return { x0, y0, w: width - x0 > halfW ? halfW : width - x0, h: height - y0 > halfH ? halfH : height - y0 };
}

// Change patterns — mutate copy in-place. Return list of quadrant indices actually touched.
const PATTERNS = [
  {
    name: "noop (0%)",
    apply: () => ({ changedQuads: [], areaPct: 0 }),
  },
  {
    name: "caret (~1%)",
    apply: (buf, w, h) => {
      // 2px vertical caret near button
      for (let y = 10; y < 28; y++) {
        for (let x = 30; x < 32; x++) {
          const i = (y * w + x) * CHANNELS;
          buf[i] = 30; buf[i + 1] = 30; buf[i + 2] = 30;
        }
      }
      return { changedQuads: [0], areaPct: pctArea(w, h, 2, 18) };
    },
  },
  {
    name: "cursor 16x16 (~2%)",
    apply: (buf, w, h) => {
      // Mouse cursor block in quadrant 1 (top-right)
      for (let y = 8; y < 24; y++) {
        for (let x = 80; x < 96; x++) {
          const i = (y * w + x) * CHANNELS;
          buf[i] = 240; buf[i + 1] = 240; buf[i + 2] = 240;
        }
      }
      return { changedQuads: [1], areaPct: pctArea(w, h, 16, 16) };
    },
  },
  {
    name: "notification 40x40 (~10%)",
    apply: (buf, w, h) => {
      // Toast bottom-right
      for (let y = 80; y < 120; y++) {
        for (let x = 80; x < 120; x++) {
          const i = (y * w + x) * CHANNELS;
          buf[i] = 200; buf[i + 1] = 120; buf[i + 2] = 40;
        }
      }
      return { changedQuads: [3], areaPct: pctArea(w, h, 40, 40) };
    },
  },
  {
    name: "1 quadrant (25%)",
    apply: (buf, w, h) => {
      const { x0, y0, w: qw, h: qh } = quadBounds(0, w, h);
      fillRect(buf, w, x0, y0, qw, qh, 60, 80, 120);
      return { changedQuads: [0], areaPct: pctArea(w, h, qw, qh) };
    },
  },
  {
    name: "top half 2-quad (~50%)",
    apply: (buf, w, h) => {
      fillRect(buf, w, 0, 0, w, Math.floor(h / 2), 90, 60, 100);
      return { changedQuads: [0, 1], areaPct: pctArea(w, h, w, Math.floor(h / 2)) };
    },
  },
  {
    name: "scroll (~50%)",
    apply: (buf, w, h) => {
      // Shift bottom half up by a few px (realistic scroll delta)
      const half = Math.floor(h / 2);
      for (let y = 0; y < half; y++) {
        for (let x = 0; x < w; x++) {
          const srcY = y + half;
          const i = (y * w + x) * CHANNELS;
          const s = (srcY * w + x) * CHANNELS;
          buf[i] = buf[s];
          buf[i + 1] = buf[s + 1];
          buf[i + 2] = buf[s + 2];
        }
      }
      return { changedQuads: [0, 1], areaPct: pctArea(w, h, w, half) };
    },
  },
  {
    name: "full (100%)",
    apply: (buf, w, h) => {
      for (let i = 0; i < buf.length; i += CHANNELS) {
        buf[i] = 200 - buf[i];
        buf[i + 1] = 200 - buf[i + 1];
        buf[i + 2] = 200 - buf[i + 2];
      }
      return { changedQuads: [0, 1, 2, 3], areaPct: 100 };
    },
  },
];

function pctArea(w, h, rw, rh) {
  return (rw * rh) / (w * h) * 100;
}

function fillRect(buf, w, x0, y0, rw, rh, r, g, b) {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * w + x) * CHANNELS;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
}

// === Quadrant checksum (sheared grid, mirror production code) ==========
function quadChecksum(buf, q, w, h) {
  const { x0, y0, w: qw, h: qh } = quadBounds(q, w, h);
  let sum = 0;
  for (let y = 0; y < qh; y += ROW_STEP) {
    const ox = ((y / ROW_STEP) | 0) % COL_STEP;
    const rowOffset = (y0 + y) * w * CHANNELS + (x0 + ox) * CHANNELS;
    for (let x = ox; x < qw; x += COL_STEP) {
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

function detectChangedQuads(prev, cur, w, h) {
  const changed = [];
  for (let q = 0; q < 4; q++) {
    if (quadChecksum(prev, q, w, h) !== quadChecksum(cur, q, w, h)) changed.push(q);
  }
  return changed;
}

// === Encoders ===========================================================
async function encodeWebp(buf, w, h) {
  return sharp(buf, { raw: { width: w, height: h, channels: CHANNELS } })
    .webp({ quality: QUALITY, effort: EFFORT })
    .toBuffer();
}

// Baseline: encode full tile, always send 1 tile.
async function strategyBaseline(curBuf, changedQuads) {
  const webp = await encodeWebp(curBuf, TILE, TILE);
  return {
    webps: [webp],
    wireBytes: WIRE_BATCH + WIRE_HEADER + webp.length,
    encodeCalls: 1,
    sendTileCount: 1, // even if nothing changed in baseline we must resend to update client
  };
}

// Quadtree: encode only changed quadrants as 64x64 regions.
async function strategyQuadtree(curBuf, changedQuads) {
  if (!changedQuads.length) return { webps: [], wireBytes: 0, encodeCalls: 0, sendTileCount: 0 };
  const webps = [];
  for (const q of changedQuads) {
    const { x0, y0, w: qw, h: qh } = quadBounds(q, TILE, TILE);
    const region = Buffer.alloc(qw * qh * CHANNELS);
    for (let y = 0; y < qh; y++) {
      curBuf.copy(region, y * qw * CHANNELS, (y0 + y) * TILE * CHANNELS + x0 * CHANNELS,
        (y0 + y) * TILE * CHANNELS + (x0 + qw) * CHANNELS);
    }
    webps.push(await encodeWebp(region, qw, qh));
  }
  const wireBytes = WIRE_BATCH + webps.length * WIRE_HEADER + webps.reduce((s, b) => s + b.length, 0);
  return { webps, wireBytes, encodeCalls: webps.length, sendTileCount: webps.length };
}

// Mask: fill static quadrants with their average color, encode 1 full tile + dirty bitmask.
async function strategyMask(curBuf, prevBuf, changedQuads) {
  if (!changedQuads.length) {
    // Nothing changed — but mask path still must "update" → send zero-byte placeholder? Skip.
    return { webps: [], wireBytes: 0, encodeCalls: 0, sendTileCount: 0, mask: 0 };
  }
  const masked = Buffer.from(curBuf);
  for (let q = 0; q < 4; q++) {
    if (changedQuads.includes(q)) continue;
    // Fill static quadrant with its average color (minimize DCT ringing at boundary)
    const avg = avgColor(curBuf, q, TILE, TILE);
    const { x0, y0, w: qw, h: qh } = quadBounds(q, TILE, TILE);
    fillRect(masked, TILE, x0, y0, qw, qh, avg.r, avg.g, avg.b);
  }
  const webp = await encodeWebp(masked, TILE, TILE);
  let mask = 0;
  for (const q of changedQuads) mask |= (1 << q);
  return { webps: [webp], wireBytes: WIRE_BATCH + WIRE_HEADER + webp.length + WIRE_MASK, encodeCalls: 1, sendTileCount: 1, mask };
}

function avgColor(buf, q, w, h) {
  const { x0, y0, w: qw, h: qh } = quadBounds(q, w, h);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y0 + qh; y++) {
    for (let x = x0; x < x0 + qw; x++) {
      const i = (y * w + x) * CHANNELS;
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
    }
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

// === Client simulation ==================================================
// Browser uses createImageBitmap (GPU). Sharp decode is CPU → absolute ms differ,
// but relative cost between strategies is meaningful.

async function decodeToRaw(webp) {
  return sharp(webp).raw().toBuffer();
}

async function clientBaseline(webp) {
  const t0 = performance.now();
  await decodeToRaw(webp);
  const decodeMs = performance.now() - t0;
  // drawImage ×1; no pixel cache needed (stateless)
  return { decodeMs, drawCalls: 1, compositeCalls: 0, pixelCacheKB: 0 };
}

async function clientQuadtree(webps) {
  const t0 = performance.now();
  await Promise.all(webps.map(decodeToRaw));
  const decodeMs = performance.now() - t0;
  return { decodeMs, drawCalls: webps.length, compositeCalls: 0, pixelCacheKB: 0 };
}

async function clientMask(webp, mask, prevPixelCacheKB) {
  // Client must: decode + composite changed regions from new bitmap,
  // keep static regions from cached previous frame.
  const t0 = performance.now();
  const decoded = await decodeToRaw(webp);
  // Composite cost: walk changed quadrants, "blit" from decoded to a persisted canvas.
  const changed = [];
  for (let q = 0; q < 4; q++) if (mask & (1 << q)) changed.push(q);
  for (const q of changed) {
    const { x0, y0, w: qw, h: qh } = quadBounds(q, TILE, TILE);
    for (let y = 0; y < qh; y++) {
      // Simulate blit cost (copy bytes)
      const srcOff = (y + y0) * TILE * CHANNELS + x0 * CHANNELS;
      decoded.subarray(srcOff, srcOff + qw * CHANNELS); // touch
    }
  }
  const decodeMs = performance.now() - t0;
  return { decodeMs, drawCalls: 1, compositeCalls: changed.length, pixelCacheKB: prevPixelCacheKB };
}

// === Runner =============================================================
async function timeAsync(fn) {
  const t0 = performance.now();
  const out = await fn();
  return { ms: performance.now() - t0, out };
}

function fmt(n, d = 1) {
  return typeof n === "number" ? n.toFixed(d) : String(n);
}

function pct(num, base) {
  if (!base) return "—";
  return (((num - base) / base) * 100).toFixed(0) + "%";
}

async function main() {
  const prevBuf = generateBaseline(TILE, TILE);

  const results = []; // {pattern, strategy, encodeMs, wireBytes, clientDecodeMs, drawCalls, sendTileCount}

  for (const pat of PATTERNS) {
    const curBuf = copyBuf(prevBuf);
    const { changedQuads, areaPct } = pat.apply(curBuf, TILE, TILE);

    // Use REAL detection (checksum) — if sheared grid misses, reflects production bug
    const detected = detectChangedQuads(prevBuf, curBuf, TILE, TILE);

    // Baseline
    {
      // warmup
      for (let i = 0; i < WARMUP; i++) await strategyBaseline(curBuf, detected);
      let encMs = 0, cliMs = 0, wire = 0, calls = 0;
      let lastWebp;
      for (let i = 0; i < ITERATIONS; i++) {
        const e = await timeAsync(() => strategyBaseline(curBuf, detected));
        encMs += e.ms;
        lastWebp = e.out.webps[0];
        wire = e.out.wireBytes;
        const c = await timeAsync(() => clientBaseline(lastWebp));
        cliMs += c.ms;
        calls = c.out.drawCalls;
      }
      results.push({ pattern: pat.name, areaPct, detected, strategy: "baseline", encodeMs: encMs / ITERATIONS, wireBytes: wire, clientMs: cliMs / ITERATIONS, drawCalls: calls, sendTileCount: detected.length ? 1 : 0 });
    }

    // Quadtree
    {
      for (let i = 0; i < WARMUP; i++) await strategyQuadtree(curBuf, detected);
      let encMs = 0, cliMs = 0, wire = 0, calls = 0, sent = 0;
      let lastWebps;
      for (let i = 0; i < ITERATIONS; i++) {
        const e = await timeAsync(() => strategyQuadtree(curBuf, detected));
        encMs += e.ms;
        lastWebps = e.out.webps;
        wire = e.out.wireBytes;
        const c = await timeAsync(() => clientQuadtree(lastWebps));
        cliMs += c.ms;
        calls = c.out.drawCalls;
        sent = e.out.sendTileCount;
      }
      results.push({ pattern: pat.name, areaPct, detected, strategy: "quadtree", encodeMs: encMs / ITERATIONS, wireBytes: wire, clientMs: cliMs / ITERATIONS, drawCalls: calls, sendTileCount: sent });
    }

    // Mask (only when something changed)
    {
      const hasChange = detected.length > 0;
      if (hasChange) {
        for (let i = 0; i < WARMUP; i++) await strategyMask(curBuf, prevBuf, detected);
        let encMs = 0, cliMs = 0, wire = 0, calls = 0, sent = 0;
        let lastWebp, lastMask;
        const CACHE_KB = (TILE * TILE * CHANNELS) / 1024; // client must hold previous pixel cache
        for (let i = 0; i < ITERATIONS; i++) {
          const e = await timeAsync(() => strategyMask(curBuf, prevBuf, detected));
          encMs += e.ms;
          lastWebp = e.out.webps[0];
          lastMask = e.out.mask;
          wire = e.out.wireBytes;
          const c = await timeAsync(() => clientMask(lastWebp, lastMask, CACHE_KB));
          cliMs += c.ms;
          calls = c.out.drawCalls;
          sent = e.out.sendTileCount;
        }
        results.push({ pattern: pat.name, areaPct, detected, strategy: "mask", encodeMs: encMs / ITERATIONS, wireBytes: wire, clientMs: cliMs / ITERATIONS, drawCalls: calls, sendTileCount: sent, cacheKB: CACHE_KB });
      } else {
        results.push({ pattern: pat.name, areaPct, detected, strategy: "mask", encodeMs: 0, wireBytes: 0, clientMs: 0, drawCalls: 0, sendTileCount: 0, cacheKB: 0 });
      }
    }
  }

  printReport(results);
}

function printReport(rows) {
  // === Agent encode + wire ===
  console.log("\n# Tile strategy benchmark — WebP q" + QUALITY + " effort " + EFFORT + ", tile " + TILE + "x" + TILE + ", " + ITERATIONS + " iters\n");

  console.log("## Agent side — encode + wire bytes\n");
  console.log("| pattern | area% | det quads | strategy | encode ms | wire bytes | vs baseline |");
  console.log("|---|---:|:--|---|---:|---:|:--|");
  for (const pat of PATTERNS) {
    const subset = rows.filter(r => r.pattern === pat.name);
    const base = subset.find(r => r.strategy === "baseline");
    for (const r of subset) {
      const qd = r.detected.length ? r.detected.join("") : "—";
      console.log(`| ${r.pattern} | ${r.areaPct.toFixed(1)} | ${qd} | ${r.strategy} | ${fmt(r.encodeMs, 2)} | ${r.wireBytes} | ${r.strategy === "baseline" ? "—" : pct(r.wireBytes, base.wireBytes)} |`);
    }
    console.log("|  |  |  |  |  |  |  |");
  }

  // === Client decode + draw ===
  console.log("\n## Client side — decode + draw cost (simulated; absolute ms not browser-accurate)\n");
  console.log("| pattern | strategy | decode ms | draw calls | send tiles | client cache KB |");
  console.log("|---|---|---:|---:|---:|---:|");
  for (const r of rows) {
    console.log(`| ${r.pattern} | ${r.strategy} | ${fmt(r.clientMs, 2)} | ${r.drawCalls} | ${r.sendTileCount} | ${r.cacheKB || 0} |`);
  }

  // === Per-pattern verdict ===
  console.log("\n## Verdict — bytes winner per pattern\n");
  console.log("| pattern | area% | baseline B | quadtree B | mask B | winner |");
  console.log("|---|---:|---:|---:|---:|---|");
  for (const pat of PATTERNS) {
    const subset = rows.filter(r => r.pattern === pat.name);
    const b = subset.find(r => r.strategy === "baseline");
    const q = subset.find(r => r.strategy === "quadtree");
    const m = subset.find(r => r.strategy === "mask");
    const candidates = [b, q, m].filter(x => x && x.wireBytes > 0).map(x => ({ s: x.strategy, w: x.wireBytes }));
    candidates.sort((a, b) => a.w - b.w);
    const winner = candidates.length ? candidates[0].s : "—";
    console.log(`| ${pat.name} | ${b.areaPct.toFixed(1)} | ${b.wireBytes} | ${q.wireBytes} | ${m.wireBytes} | **${winner}** |`);
  }

  // === Cross-strategy totals (assume uniform mix across patterns) ===
  console.log("\n## Aggregate — uniform mix across all " + PATTERNS.length + " patterns\n");
  const totals = (strat) => {
    const r = rows.filter(x => x.strategy === strat);
    return {
      wire: r.reduce((s, x) => s + x.wireBytes, 0),
      enc: r.reduce((s, x) => s + x.encodeMs, 0),
      cli: r.reduce((s, x) => s + x.clientMs, 0),
      tiles: r.reduce((s, x) => s + x.sendTileCount, 0),
    };
  };
  const tb = totals("baseline"), tq = totals("quadtree"), tm = totals("mask");
  console.log("| strategy | Σ wire bytes | Σ encode ms | Σ client ms | Σ tiles sent |");
  console.log("|---|---:|---:|---:|---:|");
  console.log(`| baseline | ${tb.wire} | ${fmt(tb.enc, 2)} | ${fmt(tb.cli, 2)} | ${tb.tiles} |`);
  console.log(`| quadtree | ${tq.wire} (${pct(tq.wire, tb.wire)}) | ${fmt(tq.enc, 2)} | ${fmt(tq.cli, 2)} | ${tq.tiles} |`);
  console.log(`| mask     | ${tm.wire} (${pct(tm.wire, tb.wire)}) | ${fmt(tm.enc, 2)} | ${fmt(tm.cli, 2)} | ${tm.tiles} |`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
