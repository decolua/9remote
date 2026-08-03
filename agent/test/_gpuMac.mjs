import koffi from "koffi";
import fs from "fs";
const txt = fs.readFileSync(new URL("../features/remote/adapters/gpuResize.js", import.meta.url), "utf8");
const SRC = txt.match(/const SRC = `([\s\S]*?)`;/)[1];
const MAX_BYTES = 512*512*4;
export function createMacGpu(batchTiles=32){
  const cl=koffi.load("/System/Library/Frameworks/OpenCL.framework/OpenCL");
  const F={
   GetPlatformIDs:cl.func("int clGetPlatformIDs(uint32_t n, void *p, uint32_t *np)"),
   GetDeviceIDs:cl.func("int clGetDeviceIDs(void *p, uint64_t t, uint32_t n, void *d, uint32_t *nd)"),
   CreateContext:cl.func("void *clCreateContext(void *p, uint32_t n, void *d, void *cb, void *ud, int32_t *err)"),
   CreateCommandQueue:cl.func("void *clCreateCommandQueue(void *c, void *d, uint64_t pr, int32_t *err)"),
   CreateProgramWithSource:cl.func("void *clCreateProgramWithSource(void *c, uint32_t n, void *s, void *l, int32_t *err)"),
   BuildProgram:cl.func("int clBuildProgram(void *p, uint32_t n, void *d, void *o, void *cb, void *ud)"),
   CreateKernel:cl.func("void *clCreateKernel(void *p, void *n, int32_t *err)"),
   CreateBuffer:cl.func("void *clCreateBuffer(void *c, uint64_t f, size_t s, void *h, int32_t *err)"),
   SetKernelArg:cl.func("int clSetKernelArg(void *k, uint32_t i, size_t s, void *v)"),
   EnqueueNDRangeKernel:cl.func("int clEnqueueNDRangeKernel(void *q, void *k, uint32_t d, void *o, void *g, void *l, uint32_t n, void *el, void *e)"),
   EnqueueWriteBuffer:cl.func("int clEnqueueWriteBuffer(void *q, void *b, uint32_t bl, size_t o, size_t s, void *p, uint32_t n, void *el, void *e)"),
   EnqueueReadBuffer:cl.func("int clEnqueueReadBuffer(void *q, void *b, uint32_t bl, size_t o, size_t s, void *p, uint32_t n, void *el, void *e)"),
   Finish:cl.func("int clFinish(void *q)")
  };
  const rd=(p)=>koffi.decode(p,"uint32_t");
  let p=koffi.alloc("uint32_t",1); F.GetPlatformIDs(0,null,p);
  const np=rd(p); const pb=koffi.alloc("void *",np); F.GetPlatformIDs(np,pb,null);
  const plat=koffi.decode(pb,"void *",np)[0];
  p=koffi.alloc("uint32_t",1); F.GetDeviceIDs(plat,4n,0,null,p);
  const nd=rd(p); const db=koffi.alloc("void *",nd); F.GetDeviceIDs(plat,4n,nd,db,null);
  const dev=koffi.decode(db,"void *",nd)[0];
  const devArr=koffi.alloc("void *",1); koffi.encode(devArr,"void *",dev);
  const errP=koffi.alloc("int32_t",1);
  const ctx=F.CreateContext(null,1,devArr,null,null,errP);
  const queue=F.CreateCommandQueue(ctx,dev,0n,errP);
  const sb=Buffer.from(SRC+"\0"); const sa=koffi.alloc("void *",1); koffi.encode(sa,"void *",sb);
  const prog=F.CreateProgramWithSource(ctx,1,sa,null,errP);
  if(F.BuildProgram(prog,1,devArr,null,null,null)!==0) throw new Error("build failed");
  const kernels={};
  for(const n of ["nearest","bilinear","bilinearBatch"]) kernels[n]=F.CreateKernel(prog,Buffer.from(n+"\0"),errP);
  const nBatch=Math.max(1,batchTiles);
  const pool=MAX_BYTES*nBatch;
  const srcMem=F.CreateBuffer(ctx,4n,BigInt(pool),null,errP);
  const dstMem=F.CreateBuffer(ctx,2n,BigInt(pool),null,errP);
  const pp=(v)=>{const a=koffi.alloc("void *",1);koffi.encode(a,"void *",v);return a;};
  const srcArg=pp(srcMem), dstArg=pp(dstMem);
  for(const k of Object.values(kernels)){F.SetKernelArg(k,0,8,srcArg);F.SetKernelArg(k,5,8,dstArg);}
  const ia=(v)=>{const a=koffi.alloc("int32_t",1);koffi.encode(a,"int32_t",v);return a;};
  return {F,ctx,queue,kernels,srcMem,dstMem,dimArgs:[ia(0),ia(0),ia(0),ia(0)],
    maxTileBytes:MAX_BYTES,maxBatchTiles:nBatch,release(){}};
}
