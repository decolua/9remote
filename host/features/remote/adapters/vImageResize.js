// vImage (Accelerate) per-tile resize — darwin-only, fallback to sharp on any
// failure. Same shape as gpuResize.js but CPU vector (NEON) instead of OpenCL:
// Accelerate is a supported Apple API, unlike OpenCL which has been deprecated
// since 10.14 and fails to build kernels under some background-service contexts.
// Bench (M2, 128px tiles, scale 0.5): ~18x faster than sharp lanczos3, and
// bit-identical to it at exact-half ratios.
import koffi from "koffi";

const ACCELERATE = "/System/Library/Frameworks/Accelerate.framework/Accelerate";
const kvImageNoFlags = 0;
const kvImageGetTempBufferSize = 128;

// vImageScale is multi-pass and writes through scratch memory, so each
// concurrency slot needs its own temp buffer — sharing one corrupts output.
// Sized for the largest tile we'd feed in; grown on demand per slot.
let _h = null;
let _tried = false;

// Sync read of the cached handle. null until initVImageResize() resolved (and
// stays null if init failed). Hot-path callers check this — no await, no throw.
export function getVImageResize() { return _h; }

// Has initVImageResize() been attempted? Lets tests assert "tried and fell
// back" without awaiting, and lets callers skip re-attempting.
export function isVImageTried() { return _tried; }

// Reset cache — test-only hook so a fresh init can be exercised in-process.
export function _resetVImageResize() { _h = null; _tried = false; }

// Load Accelerate + verify a real scale round-trips. Throws on any failure;
// callers use initVImageResize() which caches and never throws.
function _create() {
  if (process.platform !== "darwin") throw new Error("vImageResize: darwin only");
  const acc = koffi.load(ACCELERATE);
  koffi.struct("vImage_Buffer", {
    data: "void *",
    height: "unsigned long",
    width: "unsigned long",
    rowBytes: "size_t"
  });
  const scale = acc.func(
    "long vImageScale_ARGB8888(const vImage_Buffer *src, const vImage_Buffer *dst, void *tmp, uint32_t flags)"
  );

  // Smoke test: a 4x4 -> 2x2 scale must return 0. Catches a missing framework
  // or an ABI mismatch at init instead of on the first streamed frame.
  const probeSrc = Buffer.alloc(4 * 4 * 4, 0x80);
  const probeDst = Buffer.allocUnsafe(2 * 2 * 4);
  const rc = Number(scale(
    { data: probeSrc, height: 4, width: 4, rowBytes: 16 },
    { data: probeDst, height: 2, width: 2, rowBytes: 8 },
    null, kvImageNoFlags
  ));
  if (rc !== 0) throw new Error("vImageScale probe rc=" + rc);

  return { scale, temps: [] };
}

// Initialize once, cache the handle. Never throws — on any failure (non-darwin,
// missing framework, probe error) it resolves null and the caller transparently
// falls back to sharp. Idempotent: safe to await repeatedly.
export async function initVImageResize() {
  if (_tried) return _h;
  _tried = true;
  try { _h = _create(); }
  catch { _h = null; }
  return _h;
}

// Per-slot temp buffer, grown on demand. slotId null (non-streaming path) uses
// slot 0 — safe because that path has no concurrent callers.
function _temp(h, slotId, bytes) {
  if (bytes <= 0) return null;
  const id = slotId ?? 0;
  let buf = h.temps[id];
  if (!buf || buf.length < bytes) {
    buf = Buffer.allocUnsafe(bytes);
    h.temps[id] = buf;
  }
  return buf;
}

// Resize one RGBA tile. Channel order is preserved (scale is channel-agnostic),
// so RGBA in gives RGBA out. outBuf optional — when supplied (>= outBytes) it's
// written into instead of allocating. Synchronous, like resizeTile in gpuResize.
export function resizeTileVImage(h, srcBuf, sw, sh, dw, dh, slotId = null, outBuf = null) {
  if (!h) throw new Error("vImageResize: handle is null (init failed or not darwin)");
  const outBytes = dw * dh * 4;
  const out = outBuf && outBuf.length >= outBytes ? outBuf.subarray(0, outBytes) : Buffer.allocUnsafe(outBytes);

  const src = { data: srcBuf, height: sh, width: sw, rowBytes: sw * 4 };
  const dst = { data: out, height: dh, width: dw, rowBytes: dw * 4 };

  const need = Number(h.scale(src, dst, null, kvImageNoFlags | kvImageGetTempBufferSize));
  const rc = Number(h.scale(src, dst, _temp(h, slotId, need), kvImageNoFlags));
  if (rc !== 0) throw new Error("vImageScale rc=" + rc);
  return out;
}
