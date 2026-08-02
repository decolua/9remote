// GPU OpenCL per-tile resize — win32-only, fallback to sharp on any failure.
// Reuses pre-allocated src/dst buffers + cached kernel buffer-args across
// calls so a tile resize is just WriteBuffer → set dims → NDRange → ReadBuffer
// (no per-call CreateBuffer/Release, no kernel recompile). Designed for the
// hot path in TileManager.compressTileImage where only changed tiles resize.
import koffi from "koffi";

const CL_DEVICE_TYPE_GPU = 4n;
const CL_DEVICE_TYPE_ALL = 0xFFFFFFFFn;
const CL_MEM_READ_ONLY = 4;
const CL_MEM_WRITE_ONLY = 2;

// Upper bound on a tile dimension we'll ever feed in. Buffers are sized to this
// so a resize never needs to (re)allocate an OpenCL buffer.
const MAX_TILE = 512;
const MAX_BYTES = MAX_TILE * MAX_TILE * 4;

// nearest + bilinear. bilinear matches sharp "linear" closely (bench RMSE ~4).
const SRC = `
__kernel void nearest(__global const uchar4* s, int sw, int sh, int dw, int dh, __global uchar4* d){
  int x=get_global_id(0), y=get_global_id(1); if(x>=dw||y>=dh) return;
  int sx=min((int)((float)x*sw/dw),sw-1), sy=min((int)((float)y*sh/dh),sh-1);
  d[y*dw+x]=s[sy*sw+sx];
}
__kernel void bilinear(__global const uchar4* s, int sw, int sh, int dw, int dh, __global uchar4* d){
  int x=get_global_id(0), y=get_global_id(1); if(x>=dw||y>=dh) return;
  float fx=((float)x+0.5f)*(float)sw/(float)dw-0.5f, fy=((float)y+0.5f)*(float)sh/(float)dh-0.5f;
  int x0=(int)floor(fx), y0=(int)floor(fy); float tx=fx-floor(fx), ty=fy-floor(fy);
  int x0c=max(0,min(x0,sw-1)), x1c=max(0,min(x0+1,sw-1));
  int y0c=max(0,min(y0,sh-1)), y1c=max(0,min(y0+1,sh-1));
  float4 p00=convert_float4(s[y0c*sw+x0c]), p01=convert_float4(s[y0c*sw+x1c]);
  float4 p10=convert_float4(s[y1c*sw+x0c]), p11=convert_float4(s[y1c*sw+x1c]);
  d[y*dw+x]=convert_uchar4_sat_rte(mix(mix(p00,p01,tx),mix(p10,p11,tx),ty));
}`;

const rdU32 = (p) => koffi.decode(p, "uint32_t");

// Allocate a koffi pointer holding one int32 value.
function intArg(v) {
  const p = koffi.alloc("int32_t", 1);
  koffi.encode(p, "int32_t", v);
  return p;
}

// Allocate a koffi pointer holding one void* (OpenCL mem handle).
function ptrArg(v) {
  const p = koffi.alloc("void *", 1);
  koffi.encode(p, "void *", v);
  return p;
}

// Module-level cache: one OpenCL handle per process. _tried guards against
// retrying every frame after a failure (e.g. no opencl.dll) — a missing GPU is
// a static condition, not a transient one, so we resolve once and stick to it.
let _gpu = null;
let _tried = false;

// Sync read of the cached handle. null until initGpuResize() has resolved (and
// stays null if init failed). Callers in the hot path check this to decide
// whether to use the GPU path or fall back to sharp — no await, no throw.
export function getGpuResize() { return _gpu; }

// Has initGpuResize() been attempted? Lets tests assert "tried and fell back"
// without waiting on a promise, and lets callers skip re-attempting.
export function isGpuTried() { return _tried; }

// Convenience for the hot path: "should I use the GPU path?" — true only when
// init ran on win32 AND OpenCL came up. Compresses `getGpuResize() != null`.
export function isGpuAvailable() { return _gpu !== null; }

// Reset cache — test-only hook so a fresh init can be exercised in-process.
export function _resetGpuResize() { _gpu = null; _tried = false; }

// Create the OpenCL handle + pre-allocate reused buffers. Throws on any failure.
// Internal — callers use initGpuResize() which caches and never throws.
async function _createGpu() {
  if (process.platform !== "win32") throw new Error("gpuResize: win32 only");
  const cl = koffi.load("C:/Windows/System32/opencl.dll");
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

  // platform
  let p = koffi.alloc("uint32_t", 1);
  if (F.GetPlatformIDs(0, null, p) !== 0) throw new Error("clGetPlatformIDs failed");
  const np = rdU32(p);
  if (!np) throw new Error("no OpenCL platform");
  const platBuf = koffi.alloc("void *", np);
  F.GetPlatformIDs(np, platBuf, null);
  const platform = koffi.decode(platBuf, "void *", np)[0];

  // device — prefer GPU, fall back to any
  p = koffi.alloc("uint32_t", 1);
  F.GetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, 0, null, p);
  let nd = rdU32(p), devType = CL_DEVICE_TYPE_GPU;
  if (!nd) { F.GetDeviceIDs(platform, CL_DEVICE_TYPE_ALL, 0, null, p); nd = rdU32(p); devType = CL_DEVICE_TYPE_ALL; }
  if (!nd) throw new Error("no OpenCL device");
  const devBuf = koffi.alloc("void *", nd);
  if (F.GetDeviceIDs(platform, devType, nd, devBuf, null) !== 0) throw new Error("clGetDeviceIDs rc");
  const device = koffi.decode(devBuf, "void *", nd)[0];

  const devArr = koffi.alloc("void *", 1); koffi.encode(devArr, "void *", device);
  const errP = koffi.alloc("int32_t", 1);
  const ctx = F.CreateContext(null, 1, devArr, null, null, errP);
  if (!ctx) throw new Error("clCreateContext err=" + koffi.decode(errP, "int32_t"));
  const queue = F.CreateCommandQueue(ctx, device, 0n, errP);
  if (!queue) throw new Error("clCreateCommandQueue err=" + koffi.decode(errP, "int32_t"));

  // program + kernels
  const srcBuf = Buffer.from(SRC + "\0");
  const strArr = koffi.alloc("void *", 1); koffi.encode(strArr, "void *", srcBuf);
  const prog = F.CreateProgramWithSource(ctx, 1, strArr, null, errP);
  if (!prog) throw new Error("clCreateProgramWithSource err=" + koffi.decode(errP, "int32_t"));
  if (F.BuildProgram(prog, 1, devArr, null, null, null) !== 0) throw new Error("clBuildProgram failed");

  const kernels = {};
  for (const name of ["nearest", "bilinear"]) {
    const k = F.CreateKernel(prog, Buffer.from(name + "\0"), errP);
    if (!k) throw new Error(`clCreateKernel(${name}) err=${koffi.decode(errP, "int32_t")}`);
    kernels[name] = k;
  }

  // Pre-allocate src + dst at MAX_BYTES — reused for every resize.
  const srcMem = F.CreateBuffer(ctx, BigInt(CL_MEM_READ_ONLY), BigInt(MAX_BYTES), null, errP);
  if (!srcMem) throw new Error("CreateBuffer(src) err=" + koffi.decode(errP, "int32_t"));
  const dstMem = F.CreateBuffer(ctx, BigInt(CL_MEM_WRITE_ONLY), BigInt(MAX_BYTES), null, errP);
  if (!dstMem) throw new Error("CreateBuffer(dst) err=" + koffi.decode(errP, "int32_t"));

  // Bind buffer args once (arg 0 = src, arg 5 = dst) for both kernels.
  const srcArg = ptrArg(srcMem);
  const dstArg = ptrArg(dstMem);
  for (const k of Object.values(kernels)) {
    F.SetKernelArg(k, 0, 8, srcArg);
    F.SetKernelArg(k, 5, 8, dstArg);
  }

  // Persistent dim-arg pointers — overwritten in place each call (no realloc).
  const dimArgs = [intArg(0), intArg(0), intArg(0), intArg(0)];

  return {
    F, ctx, queue, kernels, srcMem, dstMem, dimArgs,
    // Bound on input size the pre-allocated buffers can hold.
    maxTileBytes: MAX_BYTES,
    release() { /* best-effort; OpenCL objects freed on process exit */ }
  };
}

// Initialize once, cache the handle. Never throws — on any failure (non-Win,
// missing opencl.dll, no GPU, build error) it resolves null and the caller
// transparently falls back to sharp. Idempotent: safe to await repeatedly.
export async function initGpuResize() {
  if (_tried) return _gpu;
  _tried = true;
  try { _gpu = await _createGpu(); }
  catch { _gpu = null; }
  return _gpu;
}

// Resize one tile. Reuses gpu.srcMem/dstMem + cached buffer args; only uploads
// src bytes, updates dims, dispatches, and reads back. outBuf optional — when
// supplied (>= outBytes) it's written into instead of allocating.
// Returns the resized RGBA buffer. Synchronous (Finish) so callers stay simple.
export function resizeTile(gpu, mode, srcBuf, sw, sh, dw, dh, outBuf = null) {
  if (!gpu) throw new Error("gpuResize: handle is null (init failed or not win32)");
  const kernel = gpu.kernels[mode];
  if (!kernel) throw new Error("gpuResize: unknown mode " + mode);
  const inBytes = sw * sh * 4;
  const outBytes = dw * dh * 4;
  if (inBytes > gpu.maxTileBytes || outBytes > gpu.maxTileBytes) {
    throw new Error("gpuResize: tile exceeds pre-allocated buffer");
  }

  const { F, queue, srcMem, dstMem, dimArgs } = gpu;
  if (F.EnqueueWriteBuffer(queue, srcMem, 1, 0n, BigInt(inBytes), srcBuf, 0, null, null) !== 0) {
    throw new Error("gpuResize: WriteBuffer rc");
  }
  // Update dims in-place (args 1..4 = sw, sh, dw, dh)
  koffi.encode(dimArgs[0], "int32_t", sw);
  koffi.encode(dimArgs[1], "int32_t", sh);
  koffi.encode(dimArgs[2], "int32_t", dw);
  koffi.encode(dimArgs[3], "int32_t", dh);
  for (let i = 0; i < 4; i++) {
    if (F.SetKernelArg(kernel, i + 1, 4, dimArgs[i]) !== 0) throw new Error(`gpuResize: SetKernelArg(${i + 1}) rc`);
  }

  const gws = koffi.alloc("size_t", 2); koffi.encode(gws, "size_t", [dw, dh], 2);
  if (F.EnqueueNDRangeKernel(queue, kernel, 2, null, gws, null, 0, null, null) !== 0) {
    throw new Error("gpuResize: NDRangeKernel rc");
  }
  if (F.Finish(queue) !== 0) throw new Error("gpuResize: Finish rc");

  const out = outBuf && outBuf.length >= outBytes ? outBuf.subarray(0, outBytes) : Buffer.allocUnsafe(outBytes);
  if (F.EnqueueReadBuffer(queue, dstMem, 1, 0n, BigInt(outBytes), out, 0, null, null) !== 0) {
    throw new Error("gpuResize: ReadBuffer rc");
  }
  return out;
}
