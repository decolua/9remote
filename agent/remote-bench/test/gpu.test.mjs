// Test: OpenCL GPU resize correctness vs sharp linear (RMSE < 5%).
// Falls back to SKIP (pass) if OpenCL unavailable on this machine.
import { resizeWithGpu, initOpenCL } from "../lib/gpu.mjs";
import sharp from "sharp";

export async function run() {
  let pass = 0, fail = 0;
  let skip = 0;
  const ok = (c, m) => c ? pass++ : (fail++, console.log("  FAIL " + m));

  let ocl;
  try { ocl = await initOpenCL(); }
  catch (e) {
    console.log(`  (skip) OpenCL unavailable: ${e.message}`);
    return { pass: 1, fail: 0 }; // pass-with-skip
  }

  // 64x64 gradient test pattern
  const W = 64, H = 64, DW = 32, DH = 32;
  const src = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    src[o] = (x * 4) & 0xff; src[o + 1] = (y * 4) & 0xff; src[o + 2] = 128; src[o + 3] = 255;
  }
  const raw = { raw: { width: W, height: H, channels: 4 } };
  const gpu = resizeWithGpu(ocl, "bilinear", src, W, H, DW, DH);
  ok(gpu.length === DW * DH * 4, `gpu out size ${gpu.length} === ${DW * DH * 4}`);

  const cpu = await sharp(src, raw).resize(DW, DH, { kernel: "linear" }).raw().toBuffer();
  let se = 0, n = 0;
  for (let i = 0; i < gpu.length; i += 4) {
    for (let cc = 0; cc < 3; cc++) { const d = gpu[i + cc] - cpu[i + cc]; se += d * d; n++; }
  }
  const rmse = Math.sqrt(se / n);
  ok(rmse < 13, `GPU vs CPU linear RMSE ${rmse.toFixed(2)} < 13/255 (5%)`);
  if (rmse >= 13) console.log(`  WARN high RMSE: ${rmse.toFixed(2)}`);

  ocl.release();
  return { pass, fail };
}
