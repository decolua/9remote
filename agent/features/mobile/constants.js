// Android mobile mirroring (scrcpy) tunables — single source of truth.

// Pinned scrcpy server version (wire framing depends on major).
export const SCRCPY_VERSION = "3.1";
export const SCRCPY_JAR_NAME = `scrcpy-server-v${SCRCPY_VERSION}`;
export const DEVICE_JAR_PATH = "/data/local/tmp/scrcpy-server.jar";

export const STREAM_DEFAULTS = {
  maxSize: 1280,
  bitRate: 12_000_000,
  maxFps: 60,
  keyFrameInterval: 1
};

export const ADB_TIMEOUTS = {
  command: 15_000,
  socketWait: 30_000,
  connect: 3_000
};

const BASE_ARGS = ["-no-boot-anim", "-no-audio"];

// -gpu host enables hardware acceleration but may fail on headless/unsupported systems.
export const GPU_HOST_ARGS = ["-gpu", "host"];

export const EMULATOR_ARGS = BASE_ARGS;
export const EMULATOR_ARGS_LOW_POWER = [...BASE_ARGS, "-no-window"];

// QEMU passthrough caps emulator RAM overhead to configured size.
export const QEMU_MEMORY_ARGS = (ramSizeMb) =>
  Number.isFinite(ramSizeMb) && ramSizeMb >= MIN_GUEST_RAM_MB
    ? ["-qemu", "-m", String(Math.round(ramSizeMb))]
    : [];

export const MIN_GUEST_RAM_MB = 1536;

export const EMULATOR = {
  bootTimeoutMs: 180_000,
  bootPollMs: 1_500,
  shutdownTimeoutMs: 20_000,
  flagRejectMs: 8_000,
  serialPattern: /^emulator-(\d+)$/
};

// Filter out noisy emulator logcat tags that flood every frame.
export const DEVICE_WATCH_MS = 4000;

export const LOGCAT_NOISE_TAGS = [
  "mapper.ranchu",
  "goldfish-address-space",
  "emuglGLESv2_enc",
  "GRALLOC-DEBUG",
  "AconfigPackage",
  "CCodec",
  "CCodecConfig",
  "CCodecBuffers",
  "CodecProperties",
  "ReflectedParamUpdater",
  "MediaCodec",
  "C2Store",
  "hw-BpHwBinder"
];

export const LOGCAT_DEFAULT_LEVEL = "I";

export const LOGCAT = {
  maxLineLength: 2000,
  batchMs: 250,
  maxBatchLines: 200,
  backlogLines: 200
};

export const APK_STAGE_DIR = "9remote-apk";
export const APK_MAX_BYTES = 500 * 1024 * 1024;

export const PREAMBLE_SIZE = 64 + 12 + 1;
export const FRAME_HEADER_SIZE = 12;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_READER_BUFFER_BYTES = 32 * 1024 * 1024;

// Frame flow control tunables.
export const FLOW = {
  ackWindow: 4,
  ackPollMs: 8,
  ackTimeoutMs: 1500,
  deadAckLimit: 8,
  pausePollMs: 200
};

// Adaptive bitrate tunables based on frame ack latency.
export const ADAPT = {
  sampleWindowMs: 4000,
  minRestartGapMs: 15_000,
  congestedRatio: 0.5,
  healthyRatio: 0.1,
  stepDown: 0.7,
  stepUp: 1.15,
  minScale: 0.35,
  maxScale: 1
};

// Video chunk size fitting SCTP limit on the file channel.
export const VIDEO_CHUNK_PAYLOAD = 56 * 1024;

export const CONTROL_TYPE = {
  injectKeycode: 0,
  injectText: 1,
  injectTouch: 2,
  injectScroll: 3,
  backOrScreenOn: 4,
  resetVideo: 17
};

export const TOUCH_ACTION = { down: 0, up: 1, move: 2 };

export const ANDROID_KEY = {
  home: 3,
  back: 4,
  power: 26,
  enter: 66,
  recents: 187,
  volumeUp: 24,
  volumeDown: 25
};

export const SLEEP_ON_HIDE_MS = 30_000;
export const IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
export const IDLE_CHECK_MS = 60_000;

export const TEXT_MAX_BYTES = 300;
export const TAP_HOLD_MS = 20;
// Min interval between touch moves to prevent swamping the channel and inflating velocity.
export const MOVE_MIN_INTERVAL_MS = 33;

export const SDK_SETUP = {
  reprobeMs: 30_000,
  downloadTimeoutMs: 30 * 60 * 1000,
  minDiskBytes: Math.ceil(7372.8 * 1024 * 1024),
  components: {
    "platform-tools": {
      urls: {
        darwin: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
        win32: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
        linux: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip"
      }
    },
    "cmdline-tools": {
      urls: {
        darwin: "https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip",
        win32: "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip",
        linux: "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
      }
    }
  }
};

export const JDK_SETUP = {
  version: 17,
  dirName: "jdk-17",
  urls: {
    darwinX64: "https://api.adoptium.net/v3/binary/latest/17/ga/mac/x64/jdk/hotspot/normal/eclipse",
    darwinArm64: "https://api.adoptium.net/v3/binary/latest/17/ga/mac/aarch64/jdk/hotspot/normal/eclipse",
    win32: "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse",
    linux: "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
  }
};

// scrcpy scroll message range [-16, 16].
export const SCROLL_RANGE = 16;
export const SWIPE_MIN_MS = 80;
export const SWIPE_STEP_MS = 16;
export const SWIPE_MAX_MS = 10_000;
