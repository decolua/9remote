// Encoder adapter — sharp (RGBA) | jpeg-turbo (BGRA/RGBA native)
// No BGRA→RGBA conversion needed: jpeg-turbo accepts BGRA via FORMAT_BGRA;
// sharp requires RGBA so convert only when sharp is paired with a BGRA source.
import sharp from "sharp";
import jpegTurboModule from "@julusian/jpeg-turbo";
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";

const jpegTurbo = jpegTurboModule.default || jpegTurboModule;

// libvips holds RAM via malloc arena — disable cache, single-thread (tiles already parallel)
sharp.cache(false);
sharp.concurrency(1);

function turboFormat(format) {
  return format === "bgra" ? jpegTurbo.FORMAT_BGRA : jpegTurbo.FORMAT_RGBA;
}

// Swap R↔B in-place for BGRA→RGBA (4x faster than byte loop via Uint32)
export function bgraToRgbaInPlace(buf) {
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  for (let i = 0; i < u32.length; i++) {
    const p = u32[i];
    u32[i] = (p & 0xff00ff00) | ((p & 0x00ff0000) >> 16) | ((p & 0x000000ff) << 16);
  }
}

export async function encodeJpeg(buffer, width, height, channels = 4, quality, formatOverride) {
  const { encoder, inputFormat, jpegQuality, tileFormat, webpEffort } = REMOTE_CONFIG.pipeline;
  // Caller-supplied quality overrides config default (adaptive profile)
  const q = quality ?? jpegQuality;
  // formatOverride lets caller pass pre-swapped RGBA buffer (e.g. per-tile resize)
  const fmt = formatOverride ?? inputFormat;

  // jpeg-turbo only encodes JPEG; WebP always routes through sharp
  if (encoder === "jpegTurbo" && tileFormat !== "webp") {
    return jpegTurbo.compressSync(buffer, {
      width,
      height,
      format: turboFormat(fmt),
      quality: q
    });
  }

  // sharp path — needs RGBA
  let input = buffer;
  if (fmt === "bgra") {
    // Copy so we don't mutate shared screen buffer
    input = Buffer.from(buffer);
    bgraToRgbaInPlace(input);
  }
  const pipeline = sharp(input, { raw: { width, height, channels } });
  return tileFormat === "webp"
    ? pipeline.webp({ quality: q, effort: webpEffort }).toBuffer()
    : pipeline.jpeg({ quality: q }).toBuffer();
}
