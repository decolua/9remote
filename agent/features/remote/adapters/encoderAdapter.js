// Encoder adapter — sharp only. BGRA sources are swapped to RGBA in-place.
import sharp from "sharp";
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";

// libvips holds RAM via malloc arena — disable cache, single-thread (tiles already parallel)
sharp.cache(false);
sharp.concurrency(1);

// Swap R↔B in-place for BGRA→RGBA (4x faster than byte loop via Uint32)
export function bgraToRgbaInPlace(buf) {
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  for (let i = 0; i < u32.length; i++) {
    const p = u32[i];
    u32[i] = (p & 0xff00ff00) | ((p & 0x00ff0000) >> 16) | ((p & 0x000000ff) << 16);
  }
}

export async function encodeJpeg(buffer, width, height, channels = 4, quality, formatOverride) {
  const { inputFormat, jpegQuality, tileFormat, webpEffort } = REMOTE_CONFIG.pipeline;
  const q = quality ?? jpegQuality;
  const fmt = formatOverride ?? inputFormat;

  // sharp needs RGBA
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
