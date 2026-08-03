// Step 9: batched multi-tile GPU resize vs per-tile loop.
// Answers "is one dispatch over N packed tiles faster than N dispatches?".
// Loads OpenCL per-OS so the shape can be measured on mac (M2) too — absolute
// ms are NOT transferable to win32, only the per-tile-vs-batch ratio is.
import koffi from "koffi";
import sharp from "sharp";

// Match the agent's encoderAdapter settings so sharp numbers are comparable
sharp.cache(false);
sharp.concurrency(1);

const CL_DEVICE_TYPE_GPU = 4n;
const CL_MEM_READ_ONLY = 4;
const CL_MEM_WRITE_ONLY = 2;

const LIB = {
  darwin: "/System/Library/Frameworks/OpenCL.framework/OpenCL",
  win32: "C:/Windows/System32/opencl.dll",
  linux: "libOpenCL.so.1"
};

// bilinear = same kernel gpuResize.js ships. bilinearBatch adds a tile-index
// lookup: global id z picks the tile, dims come from a per-tile meta buffer.
const SRC = `
__kernel void bilinear(__global const uchar4* s, int sw, int sh, int dw, int dh, __global uchar4* d){
  int x=get_global_id(0), y=get_global_id(1); if(x>=dw||y>=dh) return;
  float fx=((float)x+0.5f)*(float)sw/(float)dw-0.5f, fy=((float)y+0.5f)*(float)sh/(float)dh-0.5f;
  int x0=(int)floor(fx), y0=(int)floor(fy); float tx=fx-floor(fx), ty=fy-floor(fy);
  int x0c=max(0,min(x0,sw-1)), x1c=max(0,min(x0+1,sw-1));
  int y0c=max(0,min(y0,sh-1)), y1c=max(0,min(y0+1,sh-1));
  float4 p00=convert_float4(s[y0c*sw+x0c]), p01=convert_float4(s[y0c*sw+x1c]);
  float4 p10=convert_float4(s[y1c*sw+x0c]), p11=convert_float4(s[y1c*sw+x1c]);
  d[y*dw+x]=convert_uchar4_sat_rte(mix(mix(p00,p01,tx),mix(p10,p11,tx),ty));
}
__kernel void bilinearBatch(__global const uchar4* s, __global const int* meta, int sw, int sh, int dw, int dh, __global uchar4* d){
  int x=get_global_id(0), y=get_global_id(1), t=get_global_id(2);
  if(x>=dw||y>=dh) return;
  int soff=meta[t*2], doff=meta[t*2+1];
  float fx=((float)x+0.5f)*(float)sw/(float)dw-0.5f, fy=((float)y+0.5f)*(float)sh/(float)dh-0.5f;
  int x0=(int)floor(fx), y0=(int)floor(fy); float tx=fx-floor(fx), ty=fy-floor(fy);
  int x0c=max(0,min(x0,sw-1)), x1c=max(0,min(x0+1,sw-1));
  int y0c=max(0,min(y0,sh-1)), y1c=max(0,min(y0+1,sh-1));
  float4 p00=convert_float4(s[soff+y0c*sw+x0c]), p01=convert_float4(s[soff+y0c*sw+x1c]);
  float4 p10=convert_float4(s[soff+y1c*sw+x0c]), p11=convert_float4(s[soff+y1c*sw+x1c]);
  d[doff+y*dw+x]=convert_uchar4_sat_rte(mix(mix(p00,p01,tx),mix(p10,p11,tx),ty));
}`;

const rdU32 = (p) => koffi.decode(p, "uint32_t");
const intArg = (v) => { const p = koffi.alloc("int32_t", 1); koffi.encode(p, "int32_t", v); return p; };
const ptrArg = (v) => { const p = koffi.alloc("void *", 1); koffi.encode(p, "void *", v); return p; };

function initCL(srcBytes, dstBytes, metaBytes) {
  const libPath = LIB[process.platform];
  if (!libPath) throw new Error("no OpenCL lib path for " + process.platform);
  const cl = koffi.load(libPath);
  const F = {
    GetPlatformIDs: cl.func("int clGetPlatformIDs(uint32_t n, void *p, uint32_t *np)"),
    GetDeviceIDs: cl.func("int clGetDeviceIDs(void *p, uint64_t t, uint32_t n, void *d, uint32_t *nd)"),
    CreateContext: cl.func("void *clCreateContext(void *p, uint32_t n, void *d, void *cb, void *ud, int32_t *err)"),
    CreateCommandQueue: cl.func("void *clCreateCommandQueue(void *c, void *d, uint64_t pr, int32_t *err)"),
    CreateProgramWithSource: cl.func("void *clCreateProgramWithSource(void *c, uint32_t n, void *s, void *l, int32_t *err)"),
    BuildProgram: cl.func("int clBuildProgram(void *p, uint32_t n, void *d, void *o, void *cb, void *ud)"),
    CreateKernel: cl.func("void *clCreateKernel(void *p, void *n, int32_t *err)"),
    CreateBuffer: cl.func("void *clCreateBuffer(void *c, uint64_t f, size_t s, void *h, int32_t *err)"),
    SetKernelArg: cl.func("int clSetKernelArg(void *k, uint32_t i, size_t s, void *v)"),
    EnqueueNDRangeKernel: cl.func("int clEnqueueNDRangeKernel(void *q, void *k, uint32_t d, void *o, void *g, void *l, uint32_t n, void *el, void *e)"),
    EnqueueWriteBuffer: cl.func("int clEnqueueWriteBuffer(void *q, void *b, uint32_t bl, size_t o, size_t s, void *p, uint32_t n, void *el, void *e)"),
    EnqueueReadBuffer: cl.func("int clEnqueueReadBuffer(void *q, void *b, uint32_t bl, size_t o, size_t s, void *p, uint32_t n, void *el, void *e)"),
    Finish: cl.func("int clFinish(void *q)")
  };

  let p = koffi.alloc("uint32_t", 1);
  if (F.GetPlatformIDs(0, null, p) !== 0 || !rdU32(p)) throw new Error("no OpenCL platform");
  const np = rdU32(p);
  const platBuf = koffi.alloc("void *", np);
  F.GetPlatformIDs(np, platBuf, null);
  const platform = koffi.decode(platBuf, "void *", np)[0];

  p = koffi.alloc("uint32_t", 1);
  F.GetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, 0, null, p);
  const nd = rdU32(p);
  if (!nd) throw new Error("no OpenCL GPU device");
  const devBuf = koffi.alloc("void *", nd);
  F.GetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, nd, devBuf, null);
  const device = koffi.decode(devBuf, "void *", nd)[0];

  const devArr = koffi.alloc("void *", 1); koffi.encode(devArr, "void *", device);
  const errP = koffi.alloc("int32_t", 1);
  const ctx = F.CreateContext(null, 1, devArr, null, null, errP);
  if (!ctx) throw new Error("clCreateContext err=" + koffi.decode(errP, "int32_t"));
  const queue = F.CreateCommandQueue(ctx, device, 0n, errP);
  if (!queue) throw new Error("clCreateCommandQueue err=" + koffi.decode(errP, "int32_t"));

  const srcBuf = Buffer.from(SRC + "\0");
  const strArr = koffi.alloc("void *", 1); koffi.encode(strArr, "void *", srcBuf);
  const prog = F.CreateProgramWithSource(ctx, 1, strArr, null, errP);
  if (!prog) throw new Error("clCreateProgramWithSource failed");
  if (F.BuildProgram(prog, 1, devArr, null, null, null) !== 0) throw new Error("clBuildProgram failed");

  const kernels = {};
  for (const name of ["bilinear", "bilinearBatch"]) {
    const k = F.CreateKernel(prog, Buffer.from(name + "\0"), errP);
    if (!k) throw new Error(`clCreateKernel(${name}) err=${koffi.decode(errP, "int32_t")}`);
    kernels[name] = k;
  }

  const srcMem = F.CreateBuffer(ctx, BigInt(CL_MEM_READ_ONLY), BigInt(srcBytes), null, errP);
  const dstMem = F.CreateBuffer(ctx, BigInt(CL_MEM_WRITE_ONLY), BigInt(dstBytes), null, errP);
  const metaMem = F.CreateBuffer(ctx, BigInt(CL_MEM_READ_ONLY), BigInt(metaBytes), null, errP);
  if (!srcMem || !dstMem || !metaMem) throw new Error("CreateBuffer failed");

  // arg 0 = src, last = dst — bound once, same trick gpuResize.js uses
  const srcArg = ptrArg(srcMem), dstArg = ptrArg(dstMem), metaArg = ptrArg(metaMem);
  F.SetKernelArg(kernels.bilinear, 0, 8, srcArg);
  F.SetKernelArg(kernels.bilinear, 5, 8, dstArg);
  F.SetKernelArg(kernels.bilinearBatch, 0, 8, srcArg);
  F.SetKernelArg(kernels.bilinearBatch, 1, 8, metaArg);
  F.SetKernelArg(kernels.bilinearBatch, 6, 8, dstArg);

  return { F, ctx, queue, kernels, srcMem, dstMem, metaMem };
}

// N separate resizes: N × (write + dispatch + finish + read) — today's path.
function perTile(g, tiles, tw, th, dw, dh, out) {
  const { F, queue, srcMem, dstMem, kernels } = g;
  const k = kernels.bilinear;
  const inBytes = tw * th * 4, outBytes = dw * dh * 4;
  const dims = [intArg(tw), intArg(th), intArg(dw), intArg(dh)];
  for (let i = 0; i < 4; i++) F.SetKernelArg(k, i + 1, 4, dims[i]);
  const gws = koffi.alloc("size_t", 2); koffi.encode(gws, "size_t", [dw, dh], 2);
  for (let t = 0; t < tiles.length; t++) {
    F.EnqueueWriteBuffer(queue, srcMem, 1, 0n, BigInt(inBytes), tiles[t], 0, null, null);
    F.EnqueueNDRangeKernel(queue, k, 2, null, gws, null, 0, null, null);
    F.Finish(queue);
    F.EnqueueReadBuffer(queue, dstMem, 1, 0n, BigInt(outBytes), out.subarray(t * outBytes, (t + 1) * outBytes), 0, null, null);
  }
  return out;
}

// One dispatch over all tiles: 1 × (write + dispatch + finish + read).
// packed = tiles already contiguous (extractTile can write straight into it).
function batched(g, packed, meta, n, tw, th, dw, dh, out) {
  const { F, queue, srcMem, dstMem, metaMem, kernels } = g;
  const k = kernels.bilinearBatch;
  const dims = [intArg(tw), intArg(th), intArg(dw), intArg(dh)];
  for (let i = 0; i < 4; i++) F.SetKernelArg(k, i + 2, 4, dims[i]);
  F.EnqueueWriteBuffer(queue, metaMem, 1, 0n, BigInt(meta.length), meta, 0, null, null);
  F.EnqueueWriteBuffer(queue, srcMem, 1, 0n, BigInt(packed.length), packed, 0, null, null);
  const gws = koffi.alloc("size_t", 3); koffi.encode(gws, "size_t", [dw, dh, n], 3);
  F.EnqueueNDRangeKernel(queue, k, 3, null, gws, null, 0, null, null);
  F.Finish(queue);
  F.EnqueueReadBuffer(queue, dstMem, 1, 0n, BigInt(n * dw * dh * 4), out, 0, null, null);
  return out;
}

// sharp lanczos3 resize, N tiles through a mapLimit-style pool — mirrors what
// compressTileImage does today on non-win hosts (resize only, no encode).
async function sharpResize(tiles, tw, th, dw, dh, limit) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tiles.length) }, async () => {
    while (i < tiles.length) {
      const t = i++;
      await sharp(tiles[t], { raw: { width: tw, height: th, channels: 4 } })
        .resize(dw, dh, { kernel: "lanczos3", fastShrinkOnLoad: false })
        .raw().toBuffer();
    }
  });
  await Promise.all(workers);
}

// Pack N tiles into one tall strip (N*th rows) and resize in ONE sharp call.
// Same "one call instead of N" trick as the GPU batch — but lanczos3 samples
// across tile boundaries, so rows near a seam blend with the neighbouring tile.
async function sharpBatched(packed, n, tw, th, dw, dh) {
  return sharp(packed, { raw: { width: tw, height: th * n, channels: 4 } })
    .resize(dw, dh * n, { kernel: "lanczos3", fastShrinkOnLoad: false })
    .raw().toBuffer();
}

async function timeIt(label, fn, iters) {
  await fn(); // warm
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    median: +samples[samples.length >> 1].toFixed(3),
    min: +samples[0].toFixed(3),
    p95: +samples[Math.floor(samples.length * 0.95)].toFixed(3)
  };
}

export default async function ({ logger, tileSize } = {}) {
  // Default to this platform's real tile size (darwin 128, win32/linux 256)
  const TW = tileSize || (process.platform === "darwin" ? 128 : 256);
  const TH = TW, SCALE = 0.5;
  const DW = Math.floor(TW * SCALE), DH = Math.floor(TH * SCALE);
  const COUNTS = [3, 10, 30, 60];
  const MAXN = Math.max(...COUNTS);
  const inBytes = TW * TH * 4, outBytes = DW * DH * 4;
  const TILE_CONCURRENCY = 6; // REMOTE_CONFIG.pipeline.tileConcurrency

  let g;
  try { g = initCL(MAXN * inBytes, MAXN * outBytes, MAXN * 8); }
  catch (e) {
    logger?.warn("OpenCL unavailable — batch step skipped", { err: e.message });
    return { name: "9_gpu_batch", skipped: true, reason: e.message };
  }

  // Synthetic tiles — gradient content, deterministic
  const packed = Buffer.allocUnsafe(MAXN * inBytes);
  for (let i = 0; i < packed.length; i++) packed[i] = (i * 7 + (i >> 8)) & 0xff;
  const tiles = Array.from({ length: MAXN }, (_, t) => packed.subarray(t * inBytes, (t + 1) * inBytes));

  const rows = [];
  for (const n of COUNTS) {
    const meta = Buffer.allocUnsafe(n * 8);
    for (let t = 0; t < n; t++) {
      meta.writeInt32LE(t * TW * TH, t * 8);      // src pixel offset
      meta.writeInt32LE(t * DW * DH, t * 8 + 4);  // dst pixel offset
    }
    const outA = Buffer.allocUnsafe(n * outBytes);
    const outB = Buffer.allocUnsafe(n * outBytes);
    const sub = tiles.slice(0, n);
    const packedN = packed.subarray(0, n * inBytes);

    const a = await timeIt(`perTile n=${n}`, () => perTile(g, sub, TW, TH, DW, DH, outA), 20);
    const b = await timeIt(`batched n=${n}`, () => batched(g, packedN, meta, n, TW, TH, DW, DH, outB), 20);
    const s = await timeIt(`sharp n=${n}`, () => sharpResize(sub, TW, TH, DW, DH, TILE_CONCURRENCY), 20);
    const sb = await timeIt(`sharpBatch n=${n}`, () => sharpBatched(packedN, n, TW, TH, DW, DH), 20);

    // correctness: batched must match per-tile byte for byte
    const identical = outA.equals(outB);

    // sharp-batched seam damage: worst per-channel delta vs per-tile sharp,
    // and how many pixels differ at all. Non-zero => tile edges are wrong.
    const refParts = [];
    for (const t of sub) {
      refParts.push(await sharp(t, { raw: { width: TW, height: TH, channels: 4 } })
        .resize(DW, DH, { kernel: "lanczos3", fastShrinkOnLoad: false }).raw().toBuffer());
    }
    const ref = Buffer.concat(refParts);
    const got = await sharpBatched(packedN, n, TW, TH, DW, DH);
    let maxDelta = 0, diffPx = 0;
    for (let i = 0; i < ref.length; i += 4) {
      let bad = 0;
      for (let c = 0; c < 3; c++) { const d = Math.abs(ref[i + c] - got[i + c]); if (d > maxDelta) maxDelta = d; if (d) bad = 1; }
      diffPx += bad;
    }

    rows.push({
      n,
      sharpMs: s.median,
      sharpBatchMs: sb.median,
      perTileMs: a.median,
      gpuBatchMs: b.median,
      gpuVsSharpBatch: +(sb.median / b.median).toFixed(2),
      seamMaxDelta: maxDelta,
      seamDiffPct: +(100 * diffPx / (ref.length / 4)).toFixed(1),
      identical
    });
  }

  const tile = `${TW}x${TH}->${DW}x${DH}`;
  logger?.step("9_gpu_batch", { platform: process.platform, tile, rows });
  return { name: "9_gpu_batch", platform: process.platform, tile, rows };
}
