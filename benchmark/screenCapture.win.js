/**
 * Windows Screen Capture Benchmark
 * Uses node-screenshots (DXGI Desktop Duplication API internally via Rust/XCap)
 * No robotjs dependency (avoids C++ build tools requirement on Windows)
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
const fmt = (ms) => `${ms.toFixed(1)}ms`;
const fmtKB = (bytes) => `${(bytes / 1024).toFixed(0)}KB`;

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

  try {
    if (process.platform === "win32") {
      const gpuOut = execSync("wmic path win32_videocontroller get name /value", { encoding: "utf8", timeout: 5000 });
      info.gpu = gpuOut.match(/Name=(.+)/)?.[1]?.trim() || "unknown";
    } else if (process.platform === "darwin") {
      info.gpu = execSync("system_profiler SPDisplaysDataType | grep 'Chipset Model\\|Chip Model'", { encoding: "utf8" }).trim().split(":").pop().trim();
    }
  } catch {
    info.gpu = "unknown";
  }

  return info;
}

async function bench(name, fn, iters = ITERATIONS) {
  const memBefore = getMemMB();
  await fn(true); // warmup
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
  return {
    name, avg: +avg.toFixed(2),
    min: +Math.min(...times).toFixed(2),
    max: +Math.max(...times).toFixed(2),
    fps: +(1000 / avg).toFixed(1),
    memDelta: { rss: +(memAfter.rss - memBefore.rss).toFixed(1), heap: +(memAfter.heap - memBefore.heap).toFixed(1) },
    size: firstResult?.buffer?.length || 0,
    width: firstResult?.width || 0,
    height: firstResult?.height || 0,
    ext: firstResult?.ext || "",
    result: firstResult
  };
}

// ─── Capture methods ───

// robotjs (BitBlt GDI on Windows) — included if available
async function captureRobotjsRaw(isWarmup) {
  const robotMod = await import("@hurdlegroup/robotjs");
  const robot = robotMod.default || robotMod;
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
  const png = await sharp(buf, { raw: { width: w, height: bitmap.height, channels: 4 } })
    .png({ compressionLevel: 1 }).toBuffer();
  return { buffer: png, ext: "png", width: w, height: bitmap.height };
}

async function captureRobotjsJpeg(isWarmup) {
  const robotMod = await import("@hurdlegroup/robotjs");
  const robot = robotMod.default || robotMod;
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
  const jpg = await sharp(buf, { raw: { width: w, height: bitmap.height, channels: 4 } })
    .jpeg({ quality: JPEG_QUALITY }).toBuffer();
  return { buffer: jpg, ext: "jpg", width: w, height: bitmap.height };
}

// robotjs BGRA → jpeg-turbo (skip swap step)
async function captureRobotjsPlusJpegTurbo(isWarmup) {
  const robotMod = await import("@hurdlegroup/robotjs");
  const robot = robotMod.default || robotMod;
  const jpegTurboMod = await import("@julusian/jpeg-turbo");
  const jpegTurbo = jpegTurboMod.default || jpegTurboMod;
  const { width, height } = robot.getScreenSize();
  const bitmap = robot.screen.capture(0, 0, width, height);
  if (isWarmup) return null;
  const w = bitmap.byteWidth / bitmap.bytesPerPixel;
  const h = bitmap.height;
  // Strip row padding if present
  const expectedRowBytes = w * 4;
  let bgraBuf;
  if (bitmap.byteWidth !== expectedRowBytes) {
    bgraBuf = Buffer.alloc(w * h * 4);
    const src = Buffer.from(bitmap.image);
    for (let y = 0; y < h; y++) {
      src.copy(bgraBuf, y * expectedRowBytes, y * bitmap.byteWidth, y * bitmap.byteWidth + expectedRowBytes);
    }
  } else {
    bgraBuf = Buffer.from(bitmap.image);
  }
  const jpg = jpegTurbo.compressSync(bgraBuf, { format: jpegTurbo.FORMAT_BGRA, width: w, height: h, quality: JPEG_QUALITY });
  return { buffer: jpg, ext: "jpg", width: w, height: h };
}

// node-screenshots uses DXGI Desktop Duplication API on Windows (via Rust/XCap)
async function captureNodeScreenshotsRaw(isWarmup) {
  const { Monitor } = await import("node-screenshots");
  const sharp = (await import("sharp")).default;
  const image = Monitor.all()[0].captureImageSync();
  if (isWarmup) return null;
  const raw = image.toRawSync();
  const png = await sharp(Buffer.from(raw), { raw: { width: image.width, height: image.height, channels: 4 } })
    .png({ compressionLevel: 1 }).toBuffer();
  return { buffer: png, ext: "png", width: image.width, height: image.height };
}

async function captureNodeScreenshotsRawBuffer(isWarmup) {
  // Return raw buffer (no encode overhead) to measure pure DXGI capture speed
  const { Monitor } = await import("node-screenshots");
  const image = Monitor.all()[0].captureImageSync();
  if (isWarmup) return null;
  const raw = image.toRawSync();
  return { buffer: Buffer.from(raw), ext: "raw", width: image.width, height: image.height };
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

// node-screenshots raw + jpeg-turbo encode (BEST combo for Windows)
async function captureDxgiPlusJpegTurbo(isWarmup) {
  const { Monitor } = await import("node-screenshots");
  const jpegTurboMod = await import("@julusian/jpeg-turbo");
  const jpegTurbo = jpegTurboMod.default || jpegTurboMod;

  const image = Monitor.all()[0].captureImageSync();
  if (isWarmup) return null;

  const raw = Buffer.from(image.toRawSync());
  // node-screenshots returns RGBA, jpeg-turbo supports RGBA directly
  const jpg = jpegTurbo.compressSync(raw, {
    format: jpegTurbo.FORMAT_RGBA,
    width: image.width,
    height: image.height,
    quality: JPEG_QUALITY
  });
  return { buffer: jpg, ext: "jpg", width: image.width, height: image.height };
}

async function captureScreenshotDesktop(isWarmup) {
  const screenshot = (await import("screenshot-desktop")).default;
  const sharp = (await import("sharp")).default;
  const buf = await screenshot({ format: "jpg" });
  if (isWarmup) return null;
  const meta = await sharp(buf).metadata();
  return { buffer: buf, ext: "jpg", width: meta.width, height: meta.height };
}

// ─── Encoding benchmark ───
async function benchEncoders() {
  const { Monitor } = await import("node-screenshots");
  const sharp = (await import("sharp")).default;

  const image = Monitor.all()[0].captureImageSync();
  const rgbaBuf = Buffer.from(image.toRawSync());
  const w = image.width;
  const h = image.height;
  const rawOpts = { raw: { width: w, height: h, channels: 4 } };
  const rawSizeKB = rgbaBuf.length / 1024;

  let jpegTurbo = null;
  try {
    const mod = await import("@julusian/jpeg-turbo");
    jpegTurbo = mod.default || mod;
  } catch { /* skip */ }

  let napiImage = null;
  let napiPngInput = null;
  try {
    napiImage = await import("@napi-rs/image");
    napiPngInput = await sharp(rgbaBuf, rawOpts).png({ compressionLevel: 1 }).toBuffer();
  } catch { /* skip */ }

  const encoders = [
    { name: "sharp JPEG q30", fn: () => sharp(rgbaBuf, rawOpts).jpeg({ quality: 30 }).toBuffer(), ext: "jpg" },
    { name: "sharp JPEG q50", fn: () => sharp(rgbaBuf, rawOpts).jpeg({ quality: 50 }).toBuffer(), ext: "jpg" },
    { name: "sharp JPEG q70", fn: () => sharp(rgbaBuf, rawOpts).jpeg({ quality: 70 }).toBuffer(), ext: "jpg" },
    { name: "sharp WebP q50", fn: () => sharp(rgbaBuf, rawOpts).webp({ quality: 50 }).toBuffer(), ext: "webp" },
    { name: "sharp PNG fast", fn: () => sharp(rgbaBuf, rawOpts).png({ compressionLevel: 1 }).toBuffer(), ext: "png" },
  ];

  if (jpegTurbo) {
    for (const q of [30, 50, 70]) {
      encoders.push({
        name: `jpeg-turbo q${q}`,
        fn: () => jpegTurbo.compressSync(rgbaBuf, { format: jpegTurbo.FORMAT_RGBA, width: w, height: h, quality: q }),
        ext: "jpg"
      });
    }
  }

  if (napiImage && napiPngInput) {
    const { Transformer } = napiImage;
    encoders.push({ name: "@napi-rs JPEG q50", fn: () => new Transformer(napiPngInput).jpeg(50), ext: "jpg" });
    encoders.push({ name: "@napi-rs WebP q50", fn: () => new Transformer(napiPngInput).webp(50), ext: "webp" });
  }

  const results = [];
  for (const enc of encoders) {
    try {
      await enc.fn();
      const times = [];
      let outSize = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const s = performance.now();
        const buf = await enc.fn();
        times.push(performance.now() - s);
        if (i === 0) {
          outSize = buf.length;
          saveImg(`encode-${enc.name.replace(/[\s@/]/g, "-").toLowerCase()}.${enc.ext}`, buf);
        }
      }
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      results.push({
        name: enc.name, avg: +avg.toFixed(2), size: outSize, sizeKB: +(outSize / 1024).toFixed(0),
        ratio: +((outSize / rgbaBuf.length) * 100).toFixed(1),
        ext: enc.ext, success: true
      });
    } catch (err) {
      results.push({ name: enc.name, success: false, error: err.message });
    }
  }

  return { results, sourceWidth: w, sourceHeight: h, rawSizeKB: +rawSizeKB.toFixed(0) };
}

// ─── Tile benchmark ───
async function benchTiles() {
  const { Monitor } = await import("node-screenshots");
  const sharp = (await import("sharp")).default;

  const image = Monitor.all()[0].captureImageSync();
  const rgbaBuf = Buffer.from(image.toRawSync());
  const w = image.width;
  const h = image.height;

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

    // sharp
    const sharpStart = performance.now();
    const tilePromises = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tx = col * tileSize;
        const ty = row * tileSize;
        const tw = Math.min(tileSize, w - tx);
        const th = Math.min(tileSize, h - ty);
        const tileBuf = Buffer.alloc(tw * th * 4);
        for (let y = 0; y < th; y++) {
          rgbaBuf.copy(tileBuf, y * tw * 4, ((ty + y) * w + tx) * 4, ((ty + y) * w + tx + tw) * 4);
        }
        tilePromises.push(sharp(tileBuf, { raw: { width: tw, height: th, channels: 4 } }).jpeg({ quality: JPEG_QUALITY }).toBuffer());
      }
    }
    const sharpTiles = await Promise.all(tilePromises);
    const sharpTotalSize = sharpTiles.reduce((s, b) => s + b.length, 0);
    const sharpTime = performance.now() - sharpStart;

    const entry = {
      tileSize, totalTiles, cols, rows,
      sharp: { avg: +sharpTime.toFixed(2), totalSizeKB: +(sharpTotalSize / 1024).toFixed(0) }
    };

    // jpeg-turbo
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
            rgbaBuf.copy(tileBuf, y * tw * 4, ((ty + y) * w + tx) * 4, ((ty + y) * w + tx + tw) * 4);
          }
          const jpg = jpegTurbo.compressSync(tileBuf, { format: jpegTurbo.FORMAT_RGBA, width: tw, height: th, quality: JPEG_QUALITY });
          jtTotalSize += jpg.length;
        }
      }
      entry.jpegTurbo = { avg: +(performance.now() - jtStart).toFixed(2), totalSizeKB: +(jtTotalSize / 1024).toFixed(0) };
    }

    results.push(entry);
  }

  return { results, sourceWidth: w, sourceHeight: h };
}

// ─── Report generator ───
function findWinner(items, key, dir = "min") {
  const valid = items.filter(i => i.success !== false && i[key] > 0);
  if (!valid.length) return null;
  return dir === "min" ? valid.reduce((a, b) => a[key] < b[key] ? a : b) : valid.reduce((a, b) => a[key] > b[key] ? a : b);
}

function generateMarkdown(sysInfo, captureResults, encodeData, tileData) {
  const lines = [];
  const ln = (s = "") => lines.push(s);

  ln(`# 🖥️ Windows Screen Capture Benchmark`);
  ln();
  ln(`**Backend**: \`node-screenshots\` uses **DXGI Desktop Duplication API** (via Rust/XCap) — reads directly from GPU framebuffer for maximum performance on Windows.`);
  ln();

  ln(`## 💻 System Info`);
  ln(`| Key | Value |`);
  ln(`|-----|-------|`);
  for (const [k, v] of Object.entries(sysInfo)) ln(`| ${k} | ${v} |`);
  ln();

  ln(`## 📸 Screen Capture Speed`);
  ln(`| Method | Avg | Min | Max | FPS | RAM Δ | Size |`);
  ln(`|--------|-----|-----|-----|-----|-------|------|`);
  const capWinner = findWinner(captureResults, "avg");
  for (const r of captureResults) {
    if (r.success === false) { ln(`| ${r.name} | ❌ ${r.error || "failed"} | - | - | - | - | - |`); continue; }
    const w = r === capWinner ? " 🏆" : "";
    ln(`| ${r.name}${w} | ${fmt(r.avg)} | ${fmt(r.min)} | ${fmt(r.max)} | ${r.fps} | ${r.memDelta.rss}MB | ${fmtKB(r.size)} |`);
  }
  ln(`\n> 🏆 Winner: **${capWinner?.name}** (${fmt(capWinner?.avg || 0)}, ~${capWinner?.fps || 0} FPS)`);
  ln();

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

  ln(`## 🧩 Tile-based Encoding (JPEG q${JPEG_QUALITY})`);
  ln(`| Tile Size | Tiles | sharp (ms) | sharp Size | jpeg-turbo (ms) | jpeg-turbo Size |`);
  ln(`|-----------|-------|------------|------------|-----------------|-----------------|`);
  for (const r of tileData.results) {
    const jt = r.jpegTurbo ? `${fmt(r.jpegTurbo.avg)} | ${r.jpegTurbo.totalSizeKB}KB` : "N/A | N/A";
    ln(`| ${r.tileSize}px | ${r.totalTiles} (${r.cols}x${r.rows}) | ${fmt(r.sharp.avg)} | ${r.sharp.totalSizeKB}KB | ${jt} |`);
  }
  ln();

  ln(`## 💡 Recommendations for Windows`);
  ln(`- **Capture**: use \`node-screenshots\` — it uses DXGI Desktop Duplication (GPU framebuffer read), the fastest official Windows API`);
  if (encSpeedWinner?.name?.includes("jpeg-turbo")) {
    const sharpQ50 = encodeData.results.find(r => r.name === "sharp JPEG q50");
    const speedup = sharpQ50 ? (sharpQ50.avg / encSpeedWinner.avg).toFixed(1) : "?";
    ln(`- **Encoding**: use \`@julusian/jpeg-turbo\` — **${speedup}x faster** than sharp (${fmt(encSpeedWinner.avg)} vs ${fmt(sharpQ50?.avg || 0)})`);
  }
  ln(`- **Best combo**: node-screenshots (DXGI capture) + jpeg-turbo (SIMD encode)`);
  ln();

  return lines.join("\n");
}

// ─── Main ───
async function main() {
  const sysInfo = getSystemInfo();

  console.log("\n🚀 WINDOWS SCREEN CAPTURE BENCHMARK");
  console.log(`💻 ${sysInfo.cpu} | ${sysInfo.totalRAM} RAM | ${sysInfo.platform} ${sysInfo.arch}`);
  console.log(`🎮 GPU: ${sysInfo.gpu}`);
  console.log(`📂 Output: ${OUTPUT_DIR}`);
  console.log(`📊 Results: ${RESULTS_DIR}`);
  console.log(`ℹ️  Backend: node-screenshots uses DXGI Desktop Duplication API\n`);

  // Capture
  console.log("═".repeat(60));
  console.log("📸 CAPTURE BENCHMARK");
  console.log("═".repeat(60));

  const captureFns = [
    ["node-screenshots raw (DXGI only)", captureNodeScreenshotsRawBuffer],
    ["node-screenshots raw → sharp PNG", captureNodeScreenshotsRaw],
    ["node-screenshots built-in JPEG", captureNodeScreenshotsJpeg],
    ["node-screenshots built-in PNG", captureNodeScreenshotsPng],
    ["DXGI + jpeg-turbo (best combo)", captureDxgiPlusJpegTurbo],
    ["robotjs raw (BitBlt GDI)", captureRobotjsRaw],
    ["robotjs JPEG (BitBlt + sharp)", captureRobotjsJpeg],
    ["robotjs + jpeg-turbo (BGRA direct)", captureRobotjsPlusJpegTurbo],
    ["screenshot-desktop (PowerShell)", captureScreenshotDesktop],
  ];

  const captureResults = [];
  for (const [name, fn] of captureFns) {
    try {
      console.log(`  ⏳ ${name}...`);
      const r = await bench(name, fn);
      if (r.result && r.ext !== "raw") saveImg(`${name.replace(/[\s/()]/g, "-").toLowerCase()}.${r.ext}`, r.result.buffer);
      console.log(`  ✅ ${name}: ${fmt(r.avg)} (~${r.fps} FPS) | RAM Δ${r.memDelta.rss}MB | ${fmtKB(r.size)}`);
      captureResults.push(r);
    } catch (err) {
      console.log(`  ❌ ${name}: ${err.message}`);
      captureResults.push({ name, success: false, error: err.message, avg: 0, fps: 0, size: 0, memDelta: { rss: 0, heap: 0 } });
    }
  }

  // Encoding
  console.log("\n" + "═".repeat(60));
  console.log("🖼️  ENCODING BENCHMARK");
  console.log("═".repeat(60));
  const encodeData = await benchEncoders();
  console.log(`  📐 Source: ${encodeData.sourceWidth}x${encodeData.sourceHeight} (${encodeData.rawSizeKB}KB raw)`);
  for (const r of encodeData.results) {
    if (!r.success) { console.log(`  ❌ ${r.name}: ${r.error}`); continue; }
    console.log(`  ${r.name.padEnd(22)} ${fmt(r.avg).padEnd(10)} ${String(r.sizeKB + "KB").padEnd(10)} ${r.ratio}%`);
  }

  // Tiles
  console.log("\n" + "═".repeat(60));
  console.log("🧩 TILE BENCHMARK");
  console.log("═".repeat(60));
  const tileData = await benchTiles();
  for (const r of tileData.results) {
    const jt = r.jpegTurbo ? `jpeg-turbo: ${fmt(r.jpegTurbo.avg)} (${r.jpegTurbo.totalSizeKB}KB)` : "";
    console.log(`  ${String(r.tileSize + "px").padEnd(8)} ${String(r.totalTiles + " tiles").padEnd(14)} sharp: ${fmt(r.sharp.avg).padEnd(10)} (${r.sharp.totalSizeKB}KB)  ${jt}`);
  }

  // Save
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonData = {
    system: sysInfo,
    capture: captureResults.map(({ result, ...rest }) => rest),
    encoding: encodeData,
    tiles: tileData
  };

  fs.writeFileSync(path.join(RESULTS_DIR, `${timestamp}.json`), JSON.stringify(jsonData, null, 2));
  const mdContent = generateMarkdown(sysInfo, captureResults, encodeData, tileData);
  fs.writeFileSync(path.join(RESULTS_DIR, `${timestamp}.md`), mdContent);
  fs.writeFileSync(path.join(RESULTS_DIR, "latest.json"), JSON.stringify(jsonData, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, "latest.md"), mdContent);

  console.log(`\n💾 Report: ${path.join(RESULTS_DIR, "latest.md")}`);
  console.log("✅ DONE\n");
}

main().catch((err) => {
  console.error("\n❌ FATAL ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
