// T4: video codec (H.264 / VP8) vs tile-JPEG — bandwidth for a moving scene.
// Feeds N synthetic frames (with motion) to ffmpeg via rawvideo pipe, measures
// output size + encode time, compares to encoding every frame as tile-JPEG.
// Requires ffmpeg on PATH. Run: node tester/remote/bench/videoCodec.mjs
import { spawn } from "child_process";
import sharp from "sharp";
import { mapLimit } from "../../../features/remote/TileManager.js";
import { makeSynthetic, tileGrid, extractTile, ms, kb, stat, TILE, CONCURRENCY } from "./_shared.mjs";

sharp.cache(false);
sharp.concurrency(1);

// Smaller frame + fewer frames: video codecs shine on motion over time.
const W = 1280, H = 720, FRAMES = 60, FPS = 30, Q = 50;

// Generate FRAMES with horizontal panning motion (RGBA → we feed RGB to ffmpeg)
function frameAt(base, shift) {
  const { buffer, width, height } = base;
  const out = Buffer.allocUnsafe(width * height * 3);  // rgb24 for ffmpeg
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = (x + shift) % width;
      const si = (y * width + sx) * 4;
      const di = (y * width + x) * 3;
      out[di] = buffer[si]; out[di + 1] = buffer[si + 1]; out[di + 2] = buffer[si + 2];
    }
  }
  return out;
}

function runFfmpeg(args, frames) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ff = spawn("ffmpeg", args);
    let size = 0, err = "";
    ff.stdout.on("data", (d) => { size += d.length; });
    ff.stderr.on("data", (d) => { err += d.toString(); });
    ff.on("close", (code) => code === 0 ? resolve({ size, ms: Date.now() - t0 }) : reject(new Error(err.slice(-400))));
    (async () => { for (const f of frames) { if (!ff.stdin.write(f)) await new Promise((r) => ff.stdin.once("drain", r)); } ff.stdin.end(); })();
  });
}

async function main() {
  console.log(`=== T4 VIDEO CODEC vs TILE-JPEG (${W}x${H}, ${FRAMES} frames @ ${FPS}fps) ===\n`);
  const base = makeSynthetic(W, H);
  const frames = Array.from({ length: FRAMES }, (_, i) => frameAt(base, i * 8));  // pan 8px/frame

  const rawIn = ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "pipe:0"];

  // H.264 (VideoToolbox HW on mac, else libx264)
  const codecs = [
    ["H.264 libx264", [...rawIn, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "28", "-f", "h264", "pipe:1"]],
    ["H.264 videotoolbox", [...rawIn, "-c:v", "h264_videotoolbox", "-realtime", "1", "-b:v", "4M", "-f", "h264", "pipe:1"]],
    ["VP8 libvpx", [...rawIn, "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "4M", "-f", "ivf", "pipe:1"]]
  ];

  for (const [name, args] of codecs) {
    try {
      const r = await runFfmpeg(args, frames);
      console.log(`  ${name.padEnd(22)}: ${kb(r.size).padStart(10)} total | ${(r.size / FRAMES / 1024).toFixed(1)}KB/frame | ${r.ms}ms encode`);
    } catch (e) {
      console.log(`  ${name.padEnd(22)}: UNAVAILABLE (${e.message.split("\n").pop().slice(0, 80)})`);
    }
  }

  // Tile-JPEG baseline: encode changed tiles every frame (panning = most tiles change)
  const rgbaBase = makeSynthetic(W, H);
  const tiles = tileGrid(W, H);
  const jpeg = (raw, w, h) => sharp(raw, { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: Q }).toBuffer();
  const times = [];
  let totalSize = 0;
  for (let f = 0; f < FRAMES; f++) {
    const t = Date.now();
    const out = await mapLimit(tiles, CONCURRENCY, (tl) => jpeg(extractTile(rgbaBase, tl.x, tl.y, tl.w, tl.h), tl.w, tl.h));
    times.push(Date.now() - t);
    totalSize += out.reduce((a, b) => a + b.length, 0);
  }
  console.log(`  ${"tile-JPEG (all/frame)".padEnd(22)}: ${kb(totalSize).padStart(10)} total | ${(totalSize / FRAMES / 1024).toFixed(1)}KB/frame | frame ${ms(stat(times))}ms`);
  console.log("\n  → video codecs exploit inter-frame delta (panning) → far smaller for motion.");
  console.log("  → tile-JPEG re-sends full tiles each frame; wins only when few tiles change (static screen).");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
