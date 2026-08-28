// Android mirroring client tunables.

// A preset is a quality target, expressed as bits per pixel rather than a fixed
// bitrate: the frame size is chosen from the viewport (see fitEncodeSize), and a
// fixed bitrate spread over a larger frame just looks worse.
//   bitrate = width x height x fps x bitsPerPixel
//
// 30fps, not 60: measured against an emulator's software encoder, asking for 60
// produced 21fps at 387 KB/s while 30 produced 18fps at 143 KB/s. The extra
// 2.7x of bandwidth bought 3fps, because the encoder was the limit all along.
// edgeScale is against the viewport's PHYSICAL pixels, so a 2x phone at 900css
// asks for 1800 — far past what an emulator's encoder keeps up with. 0.55 lands
// near 1000px, which measured 143 KB/s at 18fps versus 387 KB/s at 21fps for a
// full-resolution encode.
export const STREAM_PRESETS = {
  balanced: { bitsPerPixel: 0.16, maxFps: 30, edgeScale: 0.55, maxBitRate: 4_000_000 },
  quality: { bitsPerPixel: 0.2, maxFps: 30, edgeScale: 0.8, maxBitRate: 8_000_000 },
  // Saver shrinks the frame instead of starving it: fewer, well-fed pixels beat
  // many smeared ones at the same bandwidth.
  saver: { bitsPerPixel: 0.14, maxFps: 24, edgeScale: 0.4, maxBitRate: 2_000_000 }
};

export const DEFAULT_PRESET = "balanced";

// Encoding smaller than the physical pixels the canvas occupies means the
// browser upscales, which is soft no matter how high the bitrate. Ask for the
// viewport's real pixel count, bounded so a desktop monitor does not request a
// 4K encode the device cannot produce.
export const MAX_ENCODE_EDGE = 1600;
export const MIN_ENCODE_EDGE = 640;

export function fitEncodeSize(cssLongEdge, dpr = 1, scale = 1) {
  const physical = Math.round(cssLongEdge * Math.min(dpr || 1, 3) * scale);
  const bounded = Math.min(MAX_ENCODE_EDGE, Math.max(MIN_ENCODE_EDGE, physical));
  // Encoders want an aligned edge; odd sizes get silently rounded anyway.
  return bounded - (bounded % 8);
}

/**
 * Stream options for a preset at this viewport. The long edge follows the
 * display; the bitrate follows the pixel count, so quality per pixel holds
 * whatever size we land on.
 */
export function streamOptionsFor(presetName, cssLongEdge, dpr = 1) {
  const preset = STREAM_PRESETS[presetName] || STREAM_PRESETS[DEFAULT_PRESET];
  const maxSize = fitEncodeSize(cssLongEdge, dpr, preset.edgeScale);
  // The device keeps its own aspect ratio; assume a tall 9:20 phone for the
  // estimate — the agent's real frame is close enough for a bitrate target.
  const pixels = maxSize * Math.round(maxSize * 0.45);
  const bitRate = Math.min(preset.maxBitRate, Math.round(pixels * preset.maxFps * preset.bitsPerPixel));
  return { maxSize, bitRate, maxFps: preset.maxFps };
}

// Decoded frames waiting to paint. Deep queues buy nothing but latency.
export const FRAME_QUEUE_SIZE = 3;
// Past this the decoder is behind the stream — skip ahead to the next keyframe.
// ~1s of 30fps: bursts over a tunnel must be absorbed, not treated as a stall,
// because resetting the decoder blanks the canvas and reads as a flash.
export const DECODE_QUEUE_LIMIT = 30;

// Partial access units held while their chunks arrive. Ordered channel, so a
// frame older than this many newer ones was truncated and is dropped.
export const REASSEMBLY_WINDOW = 4;

// Re-ask for a keyframe at most this often while waiting to sync.
export const KEYFRAME_REQUEST_INTERVAL_MS = 1000;

export const DEVICE_REFRESH_MS = 5000;

// Wheel normalisation. Browsers report deltas in pixels, lines or pages
// depending on the device, so convert everything to "notches" — scrcpy's scroll
// unit, which Android reads as one detent of a mouse wheel.
export const WHEEL_LINE_PX = 16;
export const WHEEL_PAGE_PX = 400;
export const WHEEL_NOTCH_PX = 100;
export const SCROLL_MAX = 16;

// The pinned mirror portals into this slot in the panes row. A shared id keeps
// the layout owning the column while MobileDock owns what goes in it.
export const MOBILE_PIN_SLOT_ID = "mobile-pin-slot";

// Logcat lines kept in the tab. A long session would otherwise grow unbounded.
export const LOG_BUFFER_LINES = 5000;

export const LOG_LEVELS = ["V", "D", "I", "W", "E", "F"];

// Verbose and Debug are the bulk of a stock device's output; start at Info and
// let the user drop lower when they actually need it.
export const DEFAULT_LOG_LEVEL = "I";

// Tailwind classes per level — warnings and errors must stand out at a glance.
export const LOG_LEVEL_CLASS = {
  V: "text-text-muted",
  D: "text-text-muted",
  I: "text-text",
  W: "text-amber-400",
  E: "text-red-400",
  F: "text-red-500 font-semibold"
};

// Boot phases reported by the agent, in the order they occur.
export const BOOT_PHASES = ["launching", "booting", "ready"];
