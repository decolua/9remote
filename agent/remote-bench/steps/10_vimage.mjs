// Step 10: vImage (Accelerate) per-tile resize vs sharp lanczos3 — darwin only.
// Accelerate is a supported Apple API (unlike OpenCL, deprecated since 10.14),
// runs on the CPU vector unit, and needs no tile batching — so it sidesteps the
// seam problem a batched sharp/GPU resize introduces.
// Checks: correctness vs sharp, edge-tile sizes, temp-buffer reuse, throughput.
import koffi from "koffi";
import sharp from "sharp";

sharp.cache(false);
sharp.concurrency(1);

const ACCELERATE = "/System/Library/Frameworks/Accelerate.framework/Accelerate";
const kvImageNoFlags = 0;
const kvImageGetTempBufferSize = 128;
const kvImageHighQualityResampling = 32;

// vImage_Buffer — data ptr + dims. rowBytes lets us point straight at a
// sub-rect of a larger frame later (no copy), though this bench keeps it tight.
function loadVImage() {
  const acc = koffi.load(ACCELERATE);
  koffi.struct("vImage_Buffer", {
    data: "void *",
    height: "unsigned long",
    width: "unsigned long",
    rowBytes: "size_t"
  });
  return {
    scale: acc.func("long vImageScale_ARGB8888(const vImage_Buffer *src, const vImage_Buffer *dst, void *tmp, uint32_t flags)")
  };
}

const buf = (data, w, h) => ({ data, height: h, width: w, rowBytes: w * 4 });

// Temp buffer is scratch the multi-pass scaler writes through — it must NOT be
// shared between concurrent scales, so size one per pool slot.
function tempSize(V, tw, th, dw, dh, flags) {
  const s = Buffer.allocUnsafe(tw * th * 4);
  const d = Buffer.allocUnsafe(dw * dh * 4);
  const n = V.scale(buf(s, tw, th), buf(d, dw, dh), null, flags | kvImageGetTempBufferSize);
  return Number(n) > 0 ? Number(n) : 0;
}

async function timeIt(fn, iters = 30) {
  await fn();
  const s = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    s.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  s.sort((a, b) => a - b);
  return { median: +s[s.length >> 1].toFixed(3), min: +s[0].toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3) };
}

// Per-channel RMSE + worst delta. Compares only RGB (alpha is constant here).
function diff(a, b) {
  let se = 0, n = 0, max = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      se += d * d; n++;
      if (Math.abs(d) > max) max = Math.abs(d);
    }
  }
  return { rmse: +Math.sqrt(se / n).toFixed(2), maxDelta: max };
}

// Screen-like content: flat panels, hard edges, 1px lines, text-ish speckle.
// Gradients alone flatter any resampler; edges are where kernels disagree.
function makeTile(tw, th, seed = 0) {
  const b = Buffer.alloc(tw * th * 4, 0xff);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const o = (y * tw + x) * 4;
      const panel = x < tw / 2 ? 240 : 32;
      const hairline = (y % 17 === seed % 17) ? 0 : panel;
      const speck = ((x * 31 + y * 17 + seed) % 23 === 0) ? 255 - hairline : hairline;
      b[o] = speck; b[o + 1] = speck; b[o + 2] = (speck + x) & 0xff; b[o + 3] = 255;
    }
  }
  return b;
}

const sharpResize = (t, tw, th, dw, dh) =>
  sharp(t, { raw: { width: tw, height: th, channels: 4 } })
    .resize(dw, dh, { kernel: "lanczos3", fastShrinkOnLoad: false })
    .raw().toBuffer();

export default async function ({ logger } = {}) {
  if (process.platform !== "darwin") {
    logger?.warn("vImage step is darwin-only — skipped");
    return { name: "10_vimage", skipped: true, reason: "not darwin" };
  }

  let V;
  try { V = loadVImage(); }
  catch (e) {
    logger?.warn("Accelerate unavailable — skipped", { err: e.message });
    return { name: "10_vimage", skipped: true, reason: e.message };
  }

  const TW = 128, TH = 128, SCALE = 0.5;
  const DW = Math.floor(TW * SCALE), DH = Math.floor(TH * SCALE);
  const COUNTS = [3, 10, 30, 60];
  const POOL = 6; // REMOTE_CONFIG.pipeline.tileConcurrency

  const tmpBytes = tempSize(V, TW, TH, DW, DH, kvImageNoFlags);
  const tmpHQBytes = tempSize(V, TW, TH, DW, DH, kvImageHighQualityResampling);
  // One temp buffer per pool slot — sharing one across slots would corrupt.
  const temps = Array.from({ length: POOL }, () => Buffer.allocUnsafe(Math.max(1, tmpBytes)));
  const tempsHQ = Array.from({ length: POOL }, () => Buffer.allocUnsafe(Math.max(1, tmpHQBytes)));

  // --- correctness vs sharp lanczos3, on screen-like content ---
  const quality = [];
  for (const [label, flags, pool] of [
    ["vImage default(lanczos3)", kvImageNoFlags, temps],
    ["vImage highQuality(lanczos5)", kvImageHighQualityResampling, tempsHQ]
  ]) {
    const t = makeTile(TW, TH, 1);
    const out = Buffer.allocUnsafe(DW * DH * 4);
    const rc = V.scale(buf(t, TW, TH), buf(out, DW, DH), pool[0], flags);
    const ref = await sharpResize(t, TW, TH, DW, DH);
    quality.push({ label, rc: Number(rc), ...diff(ref, out) });
  }

  // --- channel order: vImage is channel-agnostic for scale; prove RGBA safe ---
  // A tile with distinct R/G/B ramps must come back with channels unswapped.
  const ch = Buffer.alloc(TW * TH * 4);
  for (let i = 0; i < TW * TH; i++) { ch[i * 4] = 200; ch[i * 4 + 1] = 100; ch[i * 4 + 2] = 50; ch[i * 4 + 3] = 255; }
  const chOut = Buffer.allocUnsafe(DW * DH * 4);
  V.scale(buf(ch, TW, TH), buf(chOut, DW, DH), temps[0], kvImageNoFlags);
  const channelOrderOk = chOut[0] === 200 && chOut[1] === 100 && chOut[2] === 50 && chOut[3] === 255;

  // --- edge tiles: partial tiles at screen right/bottom have odd dims ---
  const edge = [];
  for (const [tw, th] of [[128, 47], [93, 128], [61, 39], [1, 128], [128, 1]]) {
    const dw = Math.max(1, Math.floor(tw * SCALE)), dh = Math.max(1, Math.floor(th * SCALE));
    const t = makeTile(tw, th, 2);
    const out = Buffer.allocUnsafe(dw * dh * 4);
    const sz = tempSize(V, tw, th, dw, dh, kvImageNoFlags);
    const tmp = sz > 0 ? Buffer.allocUnsafe(sz) : null;
    const rc = Number(V.scale(buf(t, tw, th), buf(out, dw, dh), tmp, kvImageNoFlags));
    let d = null;
    if (rc === 0) d = diff(await sharpResize(t, tw, th, dw, dh), out);
    edge.push({ src: `${tw}x${th}`, dst: `${dw}x${dh}`, rc, ...(d || {}) });
  }

  // --- throughput ---
  const rows = [];
  for (const n of COUNTS) {
    const tiles = Array.from({ length: n }, (_, i) => makeTile(TW, TH, i));
    const outs = Array.from({ length: n }, () => Buffer.allocUnsafe(DW * DH * 4));

    // vImage is synchronous — a plain loop, no pool needed (slot 0 temp).
    const vi = await timeIt(() => {
      for (let t = 0; t < n; t++) V.scale(buf(tiles[t], TW, TH), buf(outs[t], DW, DH), temps[0], kvImageNoFlags);
    });
    // sharp through the same 6-slot pool TileManager uses today
    const sh = await timeIt(async () => {
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(POOL, n) }, async () => {
        while (i < n) { const t = i++; await sharpResize(tiles[t], TW, TH, DW, DH); }
      }));
    });
    rows.push({ n, sharpMs: sh.median, vImageMs: vi.median, speedup: +(sh.median / vi.median).toFixed(2) });
  }

  const result = {
    name: "10_vimage",
    tile: `${TW}x${TH}->${DW}x${DH}`,
    tempBufferBytes: tmpBytes,
    tempBufferHQBytes: tmpHQBytes,
    channelOrderOk,
    quality,
    edge,
    rows
  };
  logger?.step("10_vimage", result);
  return result;
}
