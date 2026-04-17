/**
 * Screen Capture & Encoding Benchmark
 * Compare capture libraries, encoders, tile sizes, quality levels
 * Output: images to output/, results to results/
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OS_KEY = `${process.platform}-${process.arch}`;
const OUTPUT_DIR = path.join(__dirname, "output", OS_KEY);
const RESULTS_DIR = path.join(__dirname, "results", OS_KEY);

const ITERATIONS = 5;
const JPEG_QUALITY = 50;

for (const dir of [OUTPUT_DIR, RESULTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Helpers ───
function fmt(ms) { return `${ms.toFixed(1)}ms`; }
function fmtKB(bytes) { return `${(bytes / 1024).toFixed(0)}KB`; }
function fmtMB(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)}MB`; }

function getMemMB() {
  const m = process.memoryUsage();
  return { rss: +(m.rss / 1024 / 1024).toFixed(1), heap: +(m.heapUsed / 1024 / 1024).toFixed(1) };
}

function saveImg(name, buffer) {
  fs.writeFileSync(path.join(OUTPUT_DIR, name), buffer);
}

function getSystemInfo() {
  const cpus = os.cpus();
  const info = {
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    cpu: cpus[0]?.model || "unknown",
    cpuCores: cpus.length,
    cpuSpeed: `${cpus[0]?.speed || 0}MHz`,
    totalRAM: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB`,
    freeRAM: `${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)}GB`,
    nodeVersion: process.version,
    date: new Date().toISOString()
  };

  // GPU detection
  try {
    if (process.platform === "darwin") {
      info.gpu = execSync("system_profiler SPDisplaysDataType | grep 'Chipset Model\\|Chip Model'", { encoding: "utf8" }).trim().split(":").pop().trim();
    } else if (process.platform === "win32") {
      info.gpu = execSync("wmic path win32_videocontroller get name /value", { encoding: "utf8" }).match(/Name=(.+)/)?.[1]?.trim() || "unknown";
    }
  } catch { info.gpu = "unknown"; }

  return info;
}

// ─── Benchmark runner ───
async function bench(name, fn, iters = ITERATIONS) {
  const memBefore = getMemMB();

  // Warmup
  await fn(true);
  if (global.gc) global.gc();

  const times = [];
  let firstResult = null;
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    const result = await fn(false);
    times.push(performance.now() - start);
    if (i === 0) firstResult = result;
  }

  const memAfter = getMemMB();
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const fps = 1000 / avg;

  return {
    name, avg: +avg.toFixed(2), min: +min.toFixed(2), max: +max.toFixed(2),
    fps: +fps.toFixed(1),
    memDelta: { rss: +(memAfter.rss - memBefore.rss).toFixed(1), heap: +(memAfter.heap - memBefore.heap).toFixed(1) },
    memAfter,
    size: firstResult?.buffer?.length || 0,
    width: firstResult?.width || 0,
    height: firstResult?.height || 0,
    ext: firstResult?.ext || "",
    result: firstResult
  };
}

// ─── Capture methods ───
async function captureRobotjsRaw(isWarmup) {
  const robot = (await import("@hurdlegroup/robotjs")).default;
  const sharp = (await import("sharp")).default;
  const { width, height } = robot.getScreenSize();
  const bitmap = robot.screen.capture(0, 0, width, height);
  const buf = Buffer.from(bitmap.image);
  // BGRA → RGBA
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  for (let i = 0; i < u32.length; i++) {
    const p = u32[i];
    u32[i] = (p & 0xFF00FF00) | ((p & 0x00FF0000) >> 16) | ((p & 0x000000FF) << 16);
  }
  if (isWarmup) return null;
  const w = bitmap.byteWidth / bitmap.bytesPerPixel;
  const png = await sharp(buf, { raw: { width: w, height: bitmap.height, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
  return { buffer: png, ext: "png", width: w, height: bitmap.height };
}

async function captureRobotjsJpeg(isWarmup) {
  const robot = (await import("@hurdlegroup/robotjs")).default;
  const sharp = (await import("sharp")).default;
  const { width, height } = robot.getScreenSize();
  const bitmap = robot.screen.capture(0, 0, width, height);
  const buf = Buffer.from(bitmap.image);
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  for (let i = 0; i < u32.length; i++) {
    const p = u32[i];
    u32[i] = (p & 0xFF00FF00) | ((p & 0x00FF0000) >> 16) | ((p & 0x000000FF) << 16);
  }
  if (isWarmup) return null;
  const w = bitmap.byteWidth / bitmap.bytesPerPixel;
  const jpg = await sharp(buf, { raw: { width: w, height: bitmap.height, channels: 4 } }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  return { buffer: jpg, ext: "jpg", width: w, height: bitmap.height };
}

async function captureNodeScreenshotsRaw(isWarmup) {
  const { Monitor } = await import("node-screenshots");
  const sharp = (await import("sharp")).default;
  const image = Monitor.all()[0].captureImageSync();
  if (isWarmup) return null;
  const raw = image.toRawSync();
  const png = await sharp(Buffer.from(raw), { raw: { width: image.width, height: image.height, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
  return { buffer: png, ext: "png", width: image.width, height: image.height };
}

async function captureNodeScreenshotsJpeg(isWarmup) {
  const { Monitor } = await import("node-screenshots");
  const image = Monitor.all()[0].captureImageSync();
  if (isWarmup) return null;
  const jpg = image.toJpegSync();
  return { buffer: Buffer.from(jpg), ext: "jpg", width: image.width, height: image.height };
}

async function captureNodeScreenshotsPng(isWarmup) {
  const { Monitor } = await import("node-screenshots");
  const image = Monitor.all()[0].captureImageSync();
  if (isWarmup) return null;
  const png = image.toPngSync();
  return { buffer: Buffer.from(png), ext: "png", width: image.width, height: image.height };
}

async function captureScreenshotDesktop(isWarmup) {
  const screenshot = (await import("screenshot-desktop")).default;
  const sharp = (await import("sharp")).default;
  const buf = await screenshot({ format: "jpg" });
  if (isWarmup) return null;
  const meta = await sharp(buf).metadata();
  return { buffer: buf, ext: "jpg", width: meta.width, height: meta.height };
}

// ─── Encoding benchmark (from same raw source) ───
async function benchEncoders(robot, sharp) {
  const { width, height } = robot.getScreenSize();
  const bitmap = robot.screen.capture(0, 0, width, height);
  const rawBuf = Buffer.from(bitmap.image);
  const w = bitmap.byteWidth / bitmap.bytesPerPixel;
  const h = bitmap.height;

  // BGRA → RGBA for sharp
  const rgbaBuf = Buffer.from(rawBuf);
  const u32 = new Uint32Array(rgbaBuf.buffer, rgbaBuf.byteOffset, rgbaBuf.length >> 2);
  for (let i = 0; i < u32.length; i++) {
    const p = u32[i];
    u32[i] = (p & 0xFF00FF00) | ((p & 0x00FF0000) >> 16) | ((p & 0x000000FF) << 16);
  }

  const rawOpts = { raw: { width: w, height: h, channels: 4 } };
  const rawSizeKB = rawBuf.length / 1024;

  // Prepare jpeg-turbo BGRA buffer
  let jpegTurbo = null;
  try {
    const mod = await import("@julusian/jpeg-turbo");
    jpegTurbo = mod.default || mod;
  } catch { /* skip */ }

  // Prepare @napi-rs/image
  let napiImage = null;
  let napiPngInput = null;
  try {
    napiImage = await import("@napi-rs/image");
    napiPngInput = await sharp(rgbaBuf, rawOpts).png({ compressionLevel: 1 }).toBuffer();
  } catch { /* skip */ }

  const encoders = [
    // Sharp JPEG quality sweep
    { name: "sharp JPEG q30", fn: () => sharp(rgbaBuf, rawOpts).jpeg({ quality: 30 }).toBuffer(), ext: "jpg" },
    { name: "sharp JPEG q40", fn: () => sharp(rgbaBuf, rawOpts).jpeg({ quality: 40 }).toBuffer(), ext: "jpg" },
    { name: "sharp JPEG q50", fn: () => sharp(rgbaBuf, rawOpts).jpeg({ quality: 50 }).toBuffer(), ext: "jpg" },
    { name: "sharp JPEG q60", fn: () => sharp(rgbaBuf, rawOpts).jpeg({ quality: 60 }).toBuffer(), ext: "jpg" },
    { name: "sharp JPEG q70", fn: () => sharp(rgbaBuf, rawOpts).jpeg({ quality: 70 }).toBuffer(), ext: "jpg" },
    { name: "sharp JPEG q80", fn: () => sharp(rgbaBuf, rawOpts).jpeg({ quality: 80 }).toBuffer(), ext: "jpg" },
    // Sharp other formats
    { name: "sharp WebP q50", fn: () => sharp(rgbaBuf, rawOpts).webp({ quality: 50 }).toBuffer(), ext: "webp" },
    { name: "sharp PNG fast", fn: () => sharp(rgbaBuf, rawOpts).png({ compressionLevel: 1 }).toBuffer(), ext: "png" },
  ];

  // jpeg-turbo quality sweep
  if (jpegTurbo) {
    for (const q of [30, 40, 50, 60, 70, 80]) {
      encoders.push({
        name: `jpeg-turbo q${q}`,
        fn: () => jpegTurbo.compressSync(rawBuf, { format: jpegTurbo.FORMAT_BGRA, width: w, height: h, quality: q }),
        ext: "jpg"
      });
    }
  }

  // @napi-rs/image
  if (napiImage && napiPngInput) {
    const { Transformer } = napiImage;
    encoders.push({ name: "@napi-rs JPEG q50", fn: () => new Transformer(napiPngInput).jpeg(50), ext: "jpg" });
    encoders.push({ name: "@napi-rs WebP q50", fn: () => new Transformer(napiPngInput).webp(50), ext: "webp" });
  }

  const results = [];
  for (const enc of encoders) {
    try {
      await enc.fn(); // warmup
      const times = [];
      let outSize = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const s = performance.now();
        const buf = await enc.fn();
        times.push(performance.now() - s);
        if (i === 0) { outSize = buf.length; saveImg(`encode-${enc.name.replace(/[\s@/]/g, "-").toLowerCase()}.${enc.ext}`, buf); }
      }
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      results.push({
        name: enc.name, avg: +avg.toFixed(2), size: outSize, sizeKB: +(outSize / 1024).toFixed(0),
        ratio: +((outSize / rawBuf.length) * 100).toFixed(1),
        ext: enc.ext, success: true
      });
    } catch (err) {
      results.push({ name: enc.name, avg: 0, size: 0, sizeKB: 0, ratio: 0, ext: enc.ext, success: false, error: err.message });
    }
  }

  return { results, sourceWidth: w, sourceHeight: h, rawSizeKB: +rawSizeKB.toFixed(0) };
}

// ─── Tile-based encoding benchmark ───
async function benchTiles(robot, sharp) {
  const { width, height } = robot.getScreenSize();
  const bitmap = robot.screen.capture(0, 0, width, height);
  const rawBuf = Buffer.from(bitmap.image);
  const w = bitmap.byteWidth / bitmap.bytesPerPixel;
  const h = bitmap.height;

  // BGRA → RGBA
  const rgbaBuf = Buffer.from(rawBuf);
  const u32 = new Uint32Array(rgbaBuf.buffer, rgbaBuf.byteOffset, rgbaBuf.length >> 2);
  for (let i = 0; i < u32.length; i++) {
    const p = u32[i];
    u32[i] = (p & 0xFF00FF00) | ((p & 0x00FF0000) >> 16) | ((p & 0x000000FF) << 16);
  }

  let jpegTurbo = null;
  try {
    const mod = await import("@julusian/jpeg-turbo");
    jpegTurbo = mod.default || mod;
  } catch { /* skip */ }

  const tileSizes = [64, 128, 256, 512];
  const results = [];

  for (const tileSize of tileSizes) {
    const cols = Math.ceil(w / tileSize);
    const rows = Math.ceil(h / tileSize);
    const totalTiles = cols * rows;

    // Extract tiles + encode with sharp
    const sharpStart = performance.now();
    let sharpTotalSize = 0;
    const tilePromises = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tx = col * tileSize;
        const ty = row * tileSize;
        const tw = Math.min(tileSize, w - tx);
        const th = Math.min(tileSize, h - ty);
        // Extract tile from raw buffer
        const tileBuf = Buffer.alloc(tw * th * 4);
        for (let y = 0; y < th; y++) {
          rgbaBuf.copy(tileBuf, y * tw * 4, ((ty + y) * w + tx) * 4, ((ty + y) * w + tx + tw) * 4);
        }
        tilePromises.push(
          sharp(tileBuf, { raw: { width: tw, height: th, channels: 4 } }).jpeg({ quality: JPEG_QUALITY }).toBuffer()
        );
      }
    }
    const sharpTiles = await Promise.all(tilePromises);
    sharpTotalSize = sharpTiles.reduce((s, b) => s + b.length, 0);
    const sharpTime = performance.now() - sharpStart;

    const entry = {
      tileSize, totalTiles, cols, rows,
      sharp: { avg: +sharpTime.toFixed(2), totalSizeKB: +(sharpTotalSize / 1024).toFixed(0) }
    };

    // jpeg-turbo tiles
    if (jpegTurbo) {
      const jtStart = performance.now();
      let jtTotalSize = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const tx = col * tileSize;
          const ty = row * tileSize;
          const tw = Math.min(tileSize, w - tx);
          const th = Math.min(tileSize, h - ty);
          const tileBuf = Buffer.alloc(tw * th * 4);
          for (let y = 0; y < th; y++) {
            rawBuf.copy(tileBuf, y * tw * 4, ((ty + y) * w + tx) * 4, ((ty + y) * w + tx + tw) * 4);
          }
          const jpg = jpegTurbo.compressSync(tileBuf, { format: jpegTurbo.FORMAT_BGRA, width: tw, height: th, quality: JPEG_QUALITY });
          jtTotalSize += jpg.length;
        }
      }
      entry.jpegTurbo = { avg: +(performance.now() - jtStart).toFixed(2), totalSizeKB: +(jtTotalSize / 1024).toFixed(0) };
    }

    results.push(entry);
  }

  return { results, sourceWidth: w, sourceHeight: h };
}

// ─── Resize benchmark ───
async function benchResize(robot, sharp) {
  const { width, height } = robot.getScreenSize();
  const bitmap = robot.screen.capture(0, 0, width, height);
  const buf = Buffer.from(bitmap.image);
  const w = bitmap.byteWidth / bitmap.bytesPerPixel;
  const h = bitmap.height;

  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  for (let i = 0; i < u32.length; i++) {
    const p = u32[i];
    u32[i] = (p & 0xFF00FF00) | ((p & 0x00FF0000) >> 16) | ((p & 0x000000FF) << 16);
  }

  const rawOpts = { raw: { width: w, height: h, channels: 4 } };
  const halfW = Math.round(w / 2);
  const halfH = Math.round(h / 2);

  const kernels = ["nearest", "cubic", "lanczos2", "lanczos3"];
  const results = [];

  for (const kernel of kernels) {
    const times = [];
    let outSize = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const s = performance.now();
      const out = await sharp(buf, rawOpts).resize(halfW, halfH, { kernel, fit: "fill" }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
      times.push(performance.now() - s);
      if (i === 0) { outSize = out.length; saveImg(`resize-${kernel}.jpg`, out); }
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    results.push({ kernel, avg: +avg.toFixed(2), sizeKB: +(outSize / 1024).toFixed(0), targetRes: `${halfW}x${halfH}` });
  }

  return { results, sourceRes: `${w}x${h}` };
}

// ─── Report generator ───
function findWinner(items, key, dir = "min") {
  const valid = items.filter(i => i.success !== false && i[key] > 0);
  if (!valid.length) return null;
  return dir === "min" ? valid.reduce((a, b) => a[key] < b[key] ? a : b) : valid.reduce((a, b) => a[key] > b[key] ? a : b);
}

function generateMarkdown(sysInfo, captureResults, encodeData, tileData, resizeData) {
  const lines = [];
  const ln = (s = "") => lines.push(s);

  ln(`# 🖥️ Screen Capture Benchmark Results`);
  ln();
  ln(`## 💻 System Info`);
  ln(`| Key | Value |`);
  ln(`|-----|-------|`);
  for (const [k, v] of Object.entries(sysInfo)) ln(`| ${k} | ${v} |`);
  ln();

  // ─── Capture ───
  ln(`## 📸 Screen Capture Speed`);
  ln(`| Library | Avg | Min | Max | FPS | RAM Δ(RSS) | Size |`);
  ln(`|---------|-----|-----|-----|-----|------------|------|`);
  const capWinner = findWinner(captureResults, "avg");
  for (const r of captureResults) {
    const w = r === capWinner ? " 🏆" : "";
    if (r.success === false) {
      ln(`| ${r.name} | ❌ | - | - | - | - | ${r.error || "failed"} |`);
    } else {
      ln(`| ${r.name}${w} | ${fmt(r.avg)} | ${fmt(r.min)} | ${fmt(r.max)} | ${r.fps} | ${r.memDelta.rss}MB | ${fmtKB(r.size)} |`);
    }
  }
  ln(`\n> 🏆 Winner: **${capWinner?.name}** (${fmt(capWinner?.avg || 0)}, ~${capWinner?.fps || 0} FPS)`);
  ln();

  // ─── Encoding ───
  ln(`## 🖼️ Encoding Speed (source: ${encodeData.sourceWidth}x${encodeData.sourceHeight}, ${encodeData.rawSizeKB}KB raw)`);
  ln(`| Encoder | Avg | Size | Ratio |`);
  ln(`|---------|-----|------|-------|`);
  const encSpeedWinner = findWinner(encodeData.results, "avg");
  const encSizeWinner = findWinner(encodeData.results.filter(r => r.ext === "jpg" && r.success), "size");
  for (const r of encodeData.results) {
    if (!r.success) { ln(`| ${r.name} | ❌ ${r.error || ""} | - | - |`); continue; }
    const badge = r === encSpeedWinner ? " ⚡" : r === encSizeWinner ? " 📦" : "";
    ln(`| ${r.name}${badge} | ${fmt(r.avg)} | ${r.sizeKB}KB | ${r.ratio}% |`);
  }
  ln(`\n> ⚡ Fastest: **${encSpeedWinner?.name}** (${fmt(encSpeedWinner?.avg || 0)})`);
  ln(`> 📦 Smallest JPEG: **${encSizeWinner?.name}** (${encSizeWinner?.sizeKB || 0}KB)`);
  ln();

  // ─── Tiles ───
  ln(`## 🧩 Tile-based Encoding (JPEG q${JPEG_QUALITY})`);
  ln(`| Tile Size | Tiles | sharp (ms) | sharp Size | jpeg-turbo (ms) | jpeg-turbo Size |`);
  ln(`|-----------|-------|------------|------------|-----------------|-----------------|`);
  for (const r of tileData.results) {
    const jt = r.jpegTurbo ? `${fmt(r.jpegTurbo.avg)} | ${r.jpegTurbo.totalSizeKB}KB` : "N/A | N/A";
    ln(`| ${r.tileSize}px | ${r.totalTiles} (${r.cols}x${r.rows}) | ${fmt(r.sharp.avg)} | ${r.sharp.totalSizeKB}KB | ${jt} |`);
  }
  ln();

  // ─── Resize ───
  ln(`## 🔄 Resize + JPEG Encode (${resizeData.sourceRes} → half)`);
  ln(`| Kernel | Avg | Output Size |`);
  ln(`|--------|-----|-------------|`);
  const resizeWinner = findWinner(resizeData.results, "avg");
  for (const r of resizeData.results) {
    const w = r === resizeWinner ? " 🏆" : "";
    ln(`| ${r.kernel}${w} | ${fmt(r.avg)} | ${r.sizeKB}KB |`);
  }
  ln(`\n> 🏆 Fastest kernel: **${resizeWinner?.kernel}** (${fmt(resizeWinner?.avg || 0)})`);
  ln();

  // ─── Recommendations ───
  ln(`## 💡 Recommendations`);
  ln();
  if (encSpeedWinner?.name?.includes("jpeg-turbo")) {
    const sharpQ50 = encodeData.results.find(r => r.name === "sharp JPEG q50");
    const speedup = sharpQ50 ? (sharpQ50.avg / encSpeedWinner.avg).toFixed(1) : "?";
    ln(`- **Encoding**: Switch to \`@julusian/jpeg-turbo\` — **${speedup}x faster** than sharp JPEG (${fmt(encSpeedWinner.avg)} vs ${fmt(sharpQ50?.avg || 0)})`);
    ln(`  - Bonus: accepts BGRA directly → skip BGRA→RGBA conversion step`);
  }
  if (capWinner?.name?.includes("node-screenshots")) {
    ln(`- **Capture**: \`node-screenshots\` (Rust/XCap) is fastest and doesn't need robotjs`);
  }
  if (resizeWinner?.kernel === "nearest") {
    ln(`- **Resize**: \`nearest\` kernel is fastest for Retina downscale (lower quality acceptable for remote desktop)`);
  }
  ln();

  return lines.join("\n");
}

// ─── Main ───
async function main() {
  const sysInfo = getSystemInfo();

  console.log("\n🚀 SCREEN CAPTURE BENCHMARK");
  console.log(`💻 ${sysInfo.cpu} | ${sysInfo.totalRAM} RAM | ${sysInfo.platform} ${sysInfo.arch}`);
  console.log(`📂 Output: ${OUTPUT_DIR}`);
  console.log(`📊 Results: ${RESULTS_DIR}\n`);

  // ─── 1. Capture benchmark ───
  console.log("═".repeat(60));
  console.log("📸 CAPTURE BENCHMARK");
  console.log("═".repeat(60));

  const captureFns = [
    ["robotjs raw", captureRobotjsRaw],
    ["robotjs JPEG", captureRobotjsJpeg],
    ["node-screenshots raw", captureNodeScreenshotsRaw],
    ["node-screenshots JPEG", captureNodeScreenshotsJpeg],
    ["node-screenshots PNG", captureNodeScreenshotsPng],
    ["screenshot-desktop", captureScreenshotDesktop],
  ];

  const captureResults = [];
  for (const [name, fn] of captureFns) {
    try {
      console.log(`  ⏳ ${name}...`);
      const r = await bench(name, fn);
      if (r.result) saveImg(`${name.replace(/[\s/]/g, "-").toLowerCase()}.${r.ext}`, r.result.buffer);
      console.log(`  ✅ ${name}: ${fmt(r.avg)} (~${r.fps} FPS) | RAM Δ${r.memDelta.rss}MB | ${fmtKB(r.size)}`);
      captureResults.push(r);
    } catch (err) {
      console.log(`  ❌ ${name}: ${err.message}`);
      captureResults.push({ name, success: false, error: err.message, avg: 0, fps: 0, size: 0, memDelta: { rss: 0, heap: 0 } });
    }
  }

  // ─── 2. Encoding benchmark ───
  console.log("\n" + "═".repeat(60));
  console.log("🖼️  ENCODING BENCHMARK");
  console.log("═".repeat(60));

  const robot = (await import("@hurdlegroup/robotjs")).default;
  const sharp = (await import("sharp")).default;
  const encodeData = await benchEncoders(robot, sharp);

  console.log(`  📐 Source: ${encodeData.sourceWidth}x${encodeData.sourceHeight} (${encodeData.rawSizeKB}KB raw)`);
  for (const r of encodeData.results) {
    if (!r.success) { console.log(`  ❌ ${r.name}: ${r.error}`); continue; }
    console.log(`  ${r.name.padEnd(22)} ${fmt(r.avg).padEnd(10)} ${String(r.sizeKB + "KB").padEnd(10)} ${r.ratio}%`);
  }

  // ─── 3. Tile benchmark ───
  console.log("\n" + "═".repeat(60));
  console.log("🧩 TILE BENCHMARK");
  console.log("═".repeat(60));

  const tileData = await benchTiles(robot, sharp);
  for (const r of tileData.results) {
    const jt = r.jpegTurbo ? `jpeg-turbo: ${fmt(r.jpegTurbo.avg)} (${r.jpegTurbo.totalSizeKB}KB)` : "";
    console.log(`  ${String(r.tileSize + "px").padEnd(8)} ${String(r.totalTiles + " tiles").padEnd(14)} sharp: ${fmt(r.sharp.avg).padEnd(10)} (${r.sharp.totalSizeKB}KB)  ${jt}`);
  }

  // ─── 4. Resize benchmark ───
  console.log("\n" + "═".repeat(60));
  console.log("🔄 RESIZE BENCHMARK (Retina 2x → 1x)");
  console.log("═".repeat(60));

  const resizeData = await benchResize(robot, sharp);
  for (const r of resizeData.results) {
    console.log(`  ${r.kernel.padEnd(12)} ${fmt(r.avg).padEnd(10)} ${r.sizeKB}KB  → ${r.targetRes}`);
  }

  // ─── Save results ───
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonData = {
    system: sysInfo,
    capture: captureResults.map(({ result, ...rest }) => rest),
    encoding: encodeData,
    tiles: tileData,
    resize: resizeData
  };

  const jsonPath = path.join(RESULTS_DIR, `${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`\n💾 JSON: ${jsonPath}`);

  const mdContent = generateMarkdown(sysInfo, captureResults, encodeData, tileData, resizeData);
  const mdPath = path.join(RESULTS_DIR, `${timestamp}.md`);
  fs.writeFileSync(mdPath, mdContent);
  console.log(`📄 Report: ${mdPath}`);

  // Also write latest.md
  fs.writeFileSync(path.join(RESULTS_DIR, "latest.md"), mdContent);
  fs.writeFileSync(path.join(RESULTS_DIR, "latest.json"), JSON.stringify(jsonData, null, 2));

  console.log("\n✅ DONE\n");
}

main().catch(console.error);
