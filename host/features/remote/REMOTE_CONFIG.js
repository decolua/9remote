import { WORKER_URL } from "../../cli/config.js";

// Platform defaults based on screen capture benchmarks.
const PLATFORM_DEFAULTS = {
  darwin: { capture: "nodeScreenshots", tileSize: 128, inputFormat: "rgba", tileFormat: "webp" },
  win32: { capture: "nodeScreenshots", tileSize: 256, inputFormat: "rgba", tileFormat: "jpeg" },
  linux: { capture: "nodeScreenshots", tileSize: 256, inputFormat: "rgba", tileFormat: "webp" }
};

const platformCfg = PLATFORM_DEFAULTS[process.platform] || PLATFORM_DEFAULTS.linux;

export const REMOTE_CONFIG = {
  pipeline: {
    captureLib: platformCfg.capture,
    inputFormat: platformCfg.inputFormat,
    tileSize: platformCfg.tileSize,
    // Win: OpenCL per-tile resize when scale<1, fallback to sharp.
    gpuResize: process.platform === "win32",
    // Win: pack square full-size tiles into a single GPU dispatch.
    gpuBatchResize: process.platform === "win32",
    gpuBatchMaxTiles: 32,
    gpuBatchMinTiles: 2,
    // Mac: vImage per-tile resize for square tiles when scale<1, fallback to sharp.
    vImageResize: process.platform === "darwin",
    // Tile output codec: jpeg for win (libjpeg-turbo), webp for mac/linux.
    tileFormat: platformCfg.tileFormat,
    // Win: direct libjpeg-turbo compressSync fallback to sharp.
    useJpegTurbo: process.platform === "win32",
    webpEffort: 0,
    jpegQuality: 50,
    tileConcurrency: 6,
    // Downscale captured buffer before tiling/encoding to save bandwidth.
    outputScale: 1,
    // scaleMode: "smooth" tracks effective pixel density; "tier" uses stepped buckets.
    scaleMode: "smooth",
    minOutputScale: 0.25,
    maxOutputScale: 1.0,
    qualityFloor: 85,
    tierHysteresis: 0.05,
    adaptiveTiers: [
      { minEffective: 1.0, outputScale: 1.00, jpegQuality: 85 },
      { minEffective: 0.7, outputScale: 0.95, jpegQuality: 85 },
      { minEffective: 0.4, outputScale: 0.80, jpegQuality: 85 },
      { minEffective: 0,   outputScale: 0.65, jpegQuality: 85 }
    ],
    // Tile change-detection sampling — denser grid catches thin caret (1-2px).
    checksumSampling: { rowStep: 3, colStep: 8 }
  },

  webrtc: {
    enableWebRTC: true,
    enableTurn: true,
    turnApiUrl: `${WORKER_URL}/api/webrtc/turn-credentials`,
    // Fallback DO signaling relay when tunnel WS is down.
    signalingDoUrl: process.env.NREMOTE_SIGNALING_DO_URL
      || WORKER_URL.replace(/^http/, "ws") + "/signaling",
    turnRefreshInterval: (24 - 1) * 60 * 60 * 1000,
    dcMaxMessageSize: 65536,
    dcBufferThreshold: 262144,
    iceDisconnectGraceMs: 6000,
    dcChunkSize: 8,
    dcMaxTilesPerFrame: 32,
    dcReliable: true,
    dcOrdered: false,
    answerTimeout: 10000,
    maxControlBuffer: 500,
    // Flow control window capping frames in flight until acknowledged.
    ackWindow: 2,
    ackPollMs: 20,
    ackTimeoutMs: 1500
  },
  robotSettings: {
    mouseDelay: 2,
    keyboardDelay: 2
  },

  throttling: {
    mouseThrottle: 8,
    // Longer throttle for Windows dragMouse to avoid starving the stream loop.
    dragMouseThrottleWin: 40,
    keyThrottle: 25,
    typeTextThrottle: 100,
    maxTextLength: 1000
  },

  // OS cursor shape sync for Windows resize handles.
  cursorShape: {
    throttleMs: 80
  },

  resourceManagement: {
    inactiveTimeout: 2 * 60 * 1000,
    memoryCheckInterval: 60000,
    memoryWarningThreshold: 1000,
    maxTimersPerClient: 100,
    maxChunkTimersPerClient: 50,
    disconnectGraceMs: 30000
  },

  streaming: {
    activeInterval: 60,
    idleInterval: 400,
    idleThreshold: 3,
    actionCaptureDelay: 50,
    chunkSize: 32,
    chunkDelay: 5
  },

  focus: {
    paddingTiles: 4
  },

  clipboard: {
    enabled: true,
    pollInterval: 1000,
    maxTextLength: 20000
  },

  displayWake: {
    enabled: true,
    throttleMs: 30000,
    macDurationSec: 5
  },

  // Windows desktop unlock bridge: detects secure desktop lock on capture failures.
  desktopUnlock: {
    pollIntervalMs: 2000,
    retryWaitMs: 3000,
    captureErrorThreshold: 5
  },

  // Sleep inhibitor configuration for system and display sleep.
  sleepInhibit: {
    defaultMode: "never",
    // Order is the dropdown order — the off state leads, then increasing block time.
    presets: {
      "none":  null,   // do not block sleep at all
      "30m": 30 * 60 * 1000,
      "1h":  60 * 60 * 1000,
      "2h":  2 * 60 * 60 * 1000,
      "4h":  4 * 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "never": null    // never auto-stop — block sleep the whole time
    }
  },

  // Virtual desktop switcher keys per platform.
  desktopSwitch: {
    darwin: {
      prev: { keyCode: 123, mods: "control down" },
      next: { keyCode: 124, mods: "control down" },
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

  logging: {
    lifecycle: false,
    errors: true,
    dpiDetection: false,
    focus: false,
    focusEveryFrames: 60,
    metrics: false,
    metricsEveryFrames: 30,
    webrtc: false,
    resizeStats: false,
    resizeStatsEveryFrames: 60
  }
};
