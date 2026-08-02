// Step 7: GPU OpenCL resize vs CPU sharp, + dump 3 representative images.
import sharp from "sharp";
import { getRawFrame, bench } from "../lib/frame.mjs";
import { initOpenCL, resizeWithGpu } from "../lib/gpu.mjs";

sharp.cache(false); sharp.concurrency(1);

export default async function ({ logger, dumpDir } = {}) {
  const f = await getRawFrame();
  const scale = 0.5;
  const dw = Math.floor(f.width * scale), dh = Math.floor(f.height * scale);

  let ocl;
  try { ocl = await initOpenCL(); }
  catch (e) { logger?.warn("OpenCL unavailable — GPU step skipped", { err: e.message }); return { name: "7_gpu", skipped: true, reason: e.message }; }

  const rows = [];
  rows.push(await bench("GPU OpenCL nearest", () => Promise.resolve(resizeWithGpu(ocl, "nearest", f.buffer, f.width, f.height, dw, dh))));
  rows.push(await bench("GPU OpenCL bilinear", () => Promise.resolve(resizeWithGpu(ocl, "bilinear", f.buffer, f.width, f.height, dw, dh))));
  const raw = { raw: { width: f.width, height: f.height, channels: 4 } };
  rows.push(await bench("CPU sharp nearest", () => sharp(f.buffer, raw).resize(dw, dh, { kernel: "nearest" }).raw().toBuffer()));
  rows.push(await bench("CPU sharp linear", () => sharp(f.buffer, raw).resize(dw, dh, { kernel: "linear" }).raw().toBuffer()));
  rows.push(await bench("CPU sharp lanczos3", () => sharp(f.buffer, raw).resize(dw, dh, { kernel: "lanczos3" }).raw().toBuffer()));

  // Dump 3 representative images only (no spam)
  if (dumpDir) {
    const fileURLToPath = (await import("url")).fileURLToPath;
    const path = await import("path");
    const dir = fileURLToPath(dumpDir.href ? dumpDir.href : dumpDir);
    const outRaw = { raw: { width: dw, height: dh, channels: 4 } };
    await sharp(f.buffer, raw).png().toFile(path.join(dir, "original.png"));
    await sharp(resizeWithGpu(ocl, "bilinear", f.buffer, f.width, f.height, dw, dh), outRaw).png().toFile(path.join(dir, "gpu_bilinear.png"));
    await sharp(await sharp(f.buffer, raw).resize(dw, dh, { kernel: "linear" }).raw().toBuffer(), outRaw).png().toFile(path.join(dir, "cpu_linear.png"));
    logger?.info("[dump] 3 images written", { dir });
  }

  // correctness: GPU bilinear vs CPU linear RMSE
  const gpu = resizeWithGpu(ocl, "bilinear", f.buffer, f.width, f.height, dw, dh);
  const cpu = await sharp(f.buffer, raw).resize(dw, dh, { kernel: "linear" }).raw().toBuffer();
  let se = 0, n = 0;
  for (let i = 0; i < gpu.length; i += 4) for (let c = 0; c < 3; c++) { const d = gpu[i + c] - cpu[i + c]; se += d * d; n++; }
  const rmse = Math.sqrt(se / n);
  ocl.release();
  logger?.step("7_gpu", { rows, rmseVsCpuLinear: +rmse.toFixed(2), leakOutstanding: ocl.created - ocl.released });
  return { name: "7_gpu", rows, rmseVsCpuLinear: +rmse.toFixed(2) };
}
