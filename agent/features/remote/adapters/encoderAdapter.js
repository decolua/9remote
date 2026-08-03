// Encoder adapter — sharp (libvips) + direct libjpeg-turbo on win32 for fast JPEG.
// BGRA sources are swapped to RGBA in-place.
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

// Direct libjpeg-turbo handle — win32 + config-gated. Probed once (eager at startup
// via initTurboEncoder, or lazily on first encodeJpeg). Prebuilt is self-contained
// (libjpeg-turbo static-linked, no external DLL). Missing optional dep → _turbo stays
// null → encodeJpeg falls back to sharp (no crash). This avoids the old failure where a
// static top-level import crashed loadRemoteModules when the prebuilt failed to install.
let _turbo = null;        // null = unavailable/probing, object = ready
let _turboProbe = null;   // Promise|null — guarantees a single probe
function startTurboProbe() {
  if (_turboProbe) return _turboProbe;
  if (process.platform !== "win32" || !REMOTE_CONFIG.pipeline.useJpegTurbo) {
    _turboProbe = Promise.resolve(null);
    return _turboProbe;
  }
  // Dynamic import (matches the robotjs/node-screenshots pattern; esbuild keeps it
  // external, so it survives the CJS bundle without import.meta.url issues).
  _turboProbe = import("@julusian/jpeg-turbo")
    .then((m) => { _turbo = m.default || m; return _turbo; })
    .catch(() => null);
  return _turboProbe;
}

// Eager init at startup (captureAdapter.initCapture) — primes _turbo before the first
// frame and returns the handle so the caller can log ok / sharp fallback. Idempotent.
export async function initTurboEncoder() {
  return startTurboProbe();
}

// Hot-path prime. Sync — just ensures the probe is in flight; reads _turbo (null until
// resolved, so the very first tiles fall back to sharp for a few ms until import lands).
function ensureTurbo() {
  if (!_turboProbe) startTurboProbe();
}

export async function encodeJpeg(buffer, width, height, channels = 4, quality, formatOverride) {
  const { inputFormat, jpegQuality, tileFormat, webpEffort } = REMOTE_CONFIG.pipeline;
  const q = quality ?? jpegQuality;
  const fmt = formatOverride ?? inputFormat;

  ensureTurbo();
  // Win fast path: direct libjpeg-turbo (bench 5-6× faster than sharp/libvips mozjpeg).
  // Sync compressSync on main thread — ~0.07ms/tile so the brief event-loop block is
  // negligible. RGBA only; turbo still probing / missing → falls through to sharp.
  if (tileFormat === "jpeg" && channels === 4 && _turbo) {
    try {
      let rgba = buffer;
      if (fmt === "bgra") { rgba = Buffer.from(buffer); bgraToRgbaInPlace(rgba); }
      const r = _turbo.compressSync(rgba, {
        format: _turbo.FORMAT_RGBA, width, height,
        quality: q, subsampling: _turbo.SAMP_420,
      });
      return Buffer.isBuffer(r) ? r : r.data;
    } catch {
      // compressSync failed (size mismatch / internal error) → fall through to sharp
    }
  }

  // Fallback / non-win / webp: sharp (libvips)
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
