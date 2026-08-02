// OpenCL GPU resize (Intel Iris Xe exposes a platform; no NVIDIA/ffmpeg needed).
// Loads opencl.dll via koffi, compiles nearest + bilinear kernels, benchmarks.
// initOpenCL() throws on any failure → caller falls back to CPU.
import koffi from "koffi";

const CL_DEVICE_TYPE_GPU = 4n;
const CL_DEVICE_TYPE_ALL = 0xFFFFFFFFn;
const CL_MEM_READ_ONLY = 4;
const CL_MEM_WRITE_ONLY = 2;

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
const intArg = (v) => { const p = koffi.alloc("int32_t", 1); koffi.encode(p, "int32_t", v); return p; };

export async function initOpenCL() {
  if (process.platform !== "win32") throw new Error("OpenCL path is Windows-only");
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
    Finish: cl.func("int clFinish(void *q)"),
    Release: cl.func("int clReleaseMemObject(void *m)")
  };

  let p = koffi.alloc("uint32_t", 1);
  if (F.GetPlatformIDs(0, null, p) !== 0) throw new Error("clGetPlatformIDs failed");
  const np = rdU32(p);
  if (!np) throw new Error("no OpenCL platform");
  const platBuf = koffi.alloc("void *", np);
  F.GetPlatformIDs(np, platBuf, null);
  const platform = koffi.decode(platBuf, "void *", np)[0];

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

  const srcBuf = Buffer.from(SRC + "\0");
  const strArr = koffi.alloc("void *", 1); koffi.encode(strArr, "void *", srcBuf);
  const prog = F.CreateProgramWithSource(ctx, 1, strArr, null, errP);
  if (!prog) throw new Error("clCreateProgramWithSource err=" + koffi.decode(errP, "int32_t"));
  if (F.BuildProgram(prog, 1, devArr, null, null, null) !== 0) throw new Error("clBuildProgram failed");

  const kernels = {};
  const ocl = { F, ctx, queue, prog, created: 0, released: 0 };
  for (const name of ["nearest", "bilinear"]) {
    const k = F.CreateKernel(prog, Buffer.from(name + "\0"), errP);
    if (!k) throw new Error(`clCreateKernel(${name}) err=${koffi.decode(errP, "int32_t")}`);
    kernels[name] = k;
  }
  ocl.kernels = kernels;
  ocl.release = () => { /* best-effort; OpenCL objects freed on process exit */ };
  return ocl;
}

export function resizeWithGpu(ocl, mode, srcBuf, sw, sh, dw, dh) {
  const { F, ctx, queue } = ocl;
  const kernel = ocl.kernels[mode];
  if (!kernel) throw new Error("unknown mode: " + mode);
  const errP = koffi.alloc("int32_t", 1);
  const inSize = sw * sh * 4, outSize = dw * dh * 4;
  const src = F.CreateBuffer(ctx, BigInt(CL_MEM_READ_ONLY), BigInt(inSize), null, errP);
  if (!src) throw new Error("CreateBuffer(src) err=" + koffi.decode(errP, "int32_t"));
  const dst = F.CreateBuffer(ctx, BigInt(CL_MEM_WRITE_ONLY), BigInt(outSize), null, errP);
  if (!dst) throw new Error("CreateBuffer(dst) err=" + koffi.decode(errP, "int32_t"));
  ocl.created += 2;
  if (F.EnqueueWriteBuffer(queue, src, 1, 0n, BigInt(inSize), srcBuf, 0, null, null) !== 0)
    throw new Error("WriteBuffer rc");

  const setP = (i, v, s) => {
    const p = koffi.alloc(s === 8 ? "void *" : "int32_t", 1);
    if (s === 8) koffi.encode(p, "void *", v); else koffi.encode(p, "int32_t", v);
    if (F.SetKernelArg(kernel, i, s, p) !== 0) throw new Error(`SetKernelArg(${i}) rc`);
  };
  setP(0, src, 8); setP(1, sw, 4); setP(2, sh, 4); setP(3, dw, 4); setP(4, dh, 4); setP(5, dst, 8);

  const gws = koffi.alloc("size_t", 2); koffi.encode(gws, "size_t", [dw, dh], 2);
  if (F.EnqueueNDRangeKernel(queue, kernel, 2, null, gws, null, 0, null, null) !== 0)
    throw new Error("NDRangeKernel rc");
  if (F.Finish(queue) !== 0) throw new Error("Finish rc");

  const out = Buffer.allocUnsafe(outSize);
  if (F.EnqueueReadBuffer(queue, dst, 1, 0n, BigInt(outSize), out, 0, null, null) !== 0)
    throw new Error("ReadBuffer rc");
  F.Release(src); F.Release(dst); ocl.released += 2;
  return out;
}
