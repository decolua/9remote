// Remote Desktop Server Configuration

// Per-OS optimal libs based on benchmark (see benchmark/RESULT.md)
// darwin: node-screenshots async (robotjs leaks native CGImageRef on Mac)
// win32:  node-screenshots DXGI GPU + sharp (RGBA, AVX2 prebuilt optimal)
const PLATFORM_DEFAULTS = {
  darwin: { capture: "nodeScreenshots", encoder: "sharp", tileSize: 128, inputFormat: "rgba" },
  win32: { capture: "nodeScreenshots", encoder: "sharp", tileSize: 256, inputFormat: "rgba" },
  linux: { capture: "nodeScreenshots", encoder: "sharp", tileSize: 256, inputFormat: "rgba" }
};

const platformCfg = PLATFORM_DEFAULTS[process.platform] || PLATFORM_DEFAULTS.linux;

export const REMOTE_CONFIG = {
  // Capture & encoding pipeline (platform-driven)
  pipeline: {
    captureLib: platformCfg.capture,      // "robotjs" | "nodeScreenshots"
    encoder: platformCfg.encoder,         // "sharp" | "jpegTurbo"
    inputFormat: platformCfg.inputFormat, // "bgra" | "rgba" — source color order
    tileSize: platformCfg.tileSize,
    // Tile output codec — "webp" (smaller ~⅓ size, faster at effort 0) | "jpeg"
    // Web client sniffs magic bytes, so it decodes either regardless of agent version.
    tileFormat: "webp",
    webpEffort: 0,
    jpegQuality: 50,
    // Bound parallel tile encodes — caps peak sharp instances / RAM per frame
    tileConcurrency: 6,
    // Output scale — downscale captured buffer before tiling/encoding.
    // 1.0 = native (no scale), 0.75 = 75%, 0.5 = 50%. Saves bandwidth + CPU.
    // Applied via sharp resize once per frame on the full screen buffer.
    // Mouse coords are percentage-based so this does NOT affect input mapping.
    outputScale: 1,
    // Smooth outputScale — outputScale tracks effective pixel density 1:1 so
    // encoded bitmap ≈ viewer's physical pixels (no GPU upsample → sharp, minimal bytes).
    // effective = (viewerWidth * zoom * dpr) / agentWidth
    // scaleMode "smooth" → outputScale = clamp(effective, min, max) (proposed)
    // scaleMode "tier"   → legacy stepped tiers (outputScale jumps in 4 buckets)
    scaleMode: "smooth",
    minOutputScale: 0.25,
    maxOutputScale: 1.0,
    // Quality still stepped — quality has a floor so detail isn't starved at low scale.
    qualityFloor: 85,
    tierHysteresis: 0.05,
    // Legacy stepped tiers (used when scaleMode === "tier"). Kept for fallback/A-B.
    adaptiveTiers: [
      { minEffective: 1.0, outputScale: 1.00, jpegQuality: 85 },
      { minEffective: 0.7, outputScale: 0.95, jpegQuality: 85 },
      { minEffective: 0.4, outputScale: 0.80, jpegQuality: 85 },
      { minEffective: 0,   outputScale: 0.65, jpegQuality: 85 }
    ],
    // Tile change-detection sampling — denser grid catches thin caret (1-2px)
    checksumSampling: { rowStep: 3, colStep: 8 }
  },

  // WebRTC transport config
  // enableWebRTC: true  → init WebRTC manager, handle offer/answer signaling
  // enableTurn: false   → STUN P2P only, skip TURN credential fetch
  webrtc: {
    enableWebRTC: true,
    enableTurn: false,
    turnApiUrl: "https://9remote.cc/api/webrtc/turn-credentials",
    // TTL is 24h, refresh 1h before expiry
    turnRefreshInterval: (24 - 1) * 60 * 60 * 1000,
    // 64KB — SCTP hard limit per message in node-datachannel
    dcMaxMessageSize: 65536,
    // Max buffered bytes before skipping frame — ~4 frames worth at typical quality.
    // Higher than 64KB to avoid excessive drops; still caps SCTP queue growth.
    dcBufferThreshold: 262144,
    // Grace before closing RTC on ICE "disconnected" (transient network lag)
    iceDisconnectGraceMs: 6000,
    // DataChannel chunk size (tiles per message) — keep under 64KB
    dcChunkSize: 8,
    // Max tiles per DC frame — split into batches if exceeded
    dcMaxTilesPerFrame: 32,
    // DataChannel reliability mode
    // reliable: false + ordered: false → UDP-like, lowest latency, drop old frames
    dcReliable: true,
    dcOrdered: false,
    // Answer SDP timeout
    answerTimeout: 10000,
    // Max buffered control messages while no adapter ready (bound reconnect window)
    maxControlBuffer: 500
  },
  // Robot settings
  robotSettings: {
    mouseDelay: 2,
    keyboardDelay: 2
  },

  // Throttling
  throttling: {
    mouseThrottle: 8,
    keyThrottle: 25,
    typeTextThrottle: 100,
    maxTextLength: 1000
  },

  // Resource management
  resourceManagement: {
    inactiveTimeout: 2 * 60 * 1000,
    memoryCheckInterval: 60000,
    memoryWarningThreshold: 1000,
    maxTimersPerClient: 100,
    maxChunkTimersPerClient: 50,
    // WS drop + RTC not closed after this → force cleanup (fallback)
    disconnectGraceMs: 30000
  },

  // Streaming - adaptive intervals
  streaming: {
    activeInterval: 60,      // Fast interval when changes detected
    idleInterval: 400,        // Slower interval when idle
    idleThreshold: 3,         // Consecutive no-change frames to switch to idle
    actionCaptureDelay: 50,   // Delay after user action to capture
    chunkSize: 32,
    chunkDelay: 5
  },

  // Focus-based streaming — only process tiles inside client viewport + padding
  focus: {
    paddingTiles: 4           // Buffer tiles around focus region
  },

  // Display wake — nudge OS to wake display on remote activity
  displayWake: {
    enabled: true,
    throttleMs: 30000,
    macDurationSec: 5
  },

  // Sleep inhibitor — block system sleep, allow display sleep
  // mode: idle-timeout preset key. "never" = always on; "30m/1h/2h/4h/24h" = auto-off after N idle.
  sleepInhibit: {
    defaultMode: "never",
    presets: {
      "30m": 30 * 60 * 1000,
      "1h":  60 * 60 * 1000,
      "2h":  2 * 60 * 60 * 1000,
      "4h":  4 * 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "never": null
    }
  },

  // Virtual desktop / Spaces switcher.
  // darwin: AppleScript key codes (124=right, 123=left). robotjs blocked by macOS for Space switch.
  // win32: robotjs keyTap [key, modifiers].
  desktopSwitch: {
    darwin: {
      prev: { keyCode: 123, mods: "control down" },
      next: { keyCode: 124, mods: "control down" },
      // macOS: open Mission Control — user clicks "+" manually (no reliable API)
      new: { type: "missionControl" }
    },
    win32: {
      prev: ["left", ["control", "command"]],
      next: ["right", ["control", "command"]],
      new: ["d", ["control", "command"]]
    },
    linux: {
      prev: null,
      next: null,
      new: null
    }
  },

  // Logging — config-driven flags per log group. Toggle off in production.
  logging: {
    // Lifecycle — start/stop streaming, handlers attached, client cleanup
    lifecycle: false,

    // Errors — all error/warn logs
    errors: true,

    // DPI detection strategies (noisy on Windows)
    dpiDetection: false,

    // Focus region updates + per-frame saving stats
    focus: false,
    focusEveryFrames: 60,

    // Pipeline metrics — capture/encode/total/fps/tiles/compression
    metrics: false,
    metricsEveryFrames: 30,

    // WebRTC signaling/ICE/TURN events
    webrtc: false
  }
};
