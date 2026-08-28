// Android mobile mirroring (scrcpy) tunables — single source of truth.

// Pinned scrcpy server version. Bumping it means re-validating the wire framing
// in scrcpySession.js (the protocol drifts between scrcpy majors).
export const SCRCPY_VERSION = "3.1";
export const SCRCPY_JAR_NAME = `scrcpy-server-v${SCRCPY_VERSION}`;
export const DEVICE_JAR_PATH = "/data/local/tmp/scrcpy-server.jar";

// Stream defaults — emulators reject encoder sizes above ~2560, so cap the edge.
export const STREAM_DEFAULTS = {
  maxSize: 1280,
  bitRate: 12_000_000,
  maxFps: 60,
  // Seconds between forced keyframes. Recovery after a dropped frame waits for
  // one of these, so a long interval shows as a freeze; but each keyframe is
  // ~20x a delta frame, so 1s is the balance scrcpy itself ships with.
  keyFrameInterval: 1
};

export const ADB_TIMEOUTS = {
  command: 15_000,
  socketWait: 30_000,   // device-side abstract socket to appear
  connect: 3_000
};

// A cold AVD takes ~30s to reach sys.boot_completed; give it room but don't
// hang the UI forever on a wedged image.
// Launch flags for AVDs we start ourselves.
//   -gpu host: the single biggest lever, for both smoothness AND host load. The
//     default "auto" falls back to a software Vulkan compositor (SwiftShader) on
//     Apple Silicon; forcing host selects MoltenVK. Measured on one AVD:
//     13fps/377% CPU with auto, 18fps/382% with host, and — crucially — host is
//     what lets the windowless mode below stay on the real GPU.
//   -no-boot-anim: shaves a couple of seconds off a cold boot.
//   -no-audio: nothing here plays the device's audio.
const BASE_ARGS = ["-gpu", "host", "-no-boot-anim", "-no-audio"];

// Windowless mode. Measured against the same AVD and workload:
//     windowed:  18.0 fps, 382% CPU
//     windowless: 4.0 fps,  61% CPU
// Six times less CPU for a quarter of the frame rate — worth it when the host is
// thermally limited or on battery, and fine for tapping through an app or
// reading logs, but not for scrolling or animation.
export const EMULATOR_ARGS = BASE_ARGS;
export const EMULATOR_ARGS_LOW_POWER = [...BASE_ARGS, "-no-window"];

export const EMULATOR = {
  bootTimeoutMs: 180_000,
  bootPollMs: 1_500,
  shutdownTimeoutMs: 20_000,
  // Emulator console ports are even, 5554..5682 — the serial encodes the port.
  serialPattern: /^emulator-(\d+)$/
};

// Emulator/vendor components that log a known-harmless error every frame. On a
// stock AVD `mapper.ranchu` alone is ~30% of all output, which buries whatever
// the user is actually debugging. Dropped agent-side so it never costs
// bandwidth; the UI can ask for it back with includeNoise.
// How often the agent re-checks which devices are up, so the header button can
// show whether anything is running. Cheap: one `adb devices` call, no per-device
// shell. Only runs while a client is connected.
export const DEVICE_WATCH_MS = 4000;

export const LOGCAT_NOISE_TAGS = [
  // Emulator graphics stack — one line per buffer.
  "mapper.ranchu",
  "goldfish-address-space",
  "emuglGLESv2_enc",
  "GRALLOC-DEBUG",
  // Framework feature-flag dump: ~40% of all output on a stock AVD, and never
  // about the app being debugged.
  "AconfigPackage",
  // The media codec that mirroring itself starts — noise this feature causes.
  "CCodec",
  "CCodecConfig",
  "CCodecBuffers",
  "CodecProperties",
  "ReflectedParamUpdater",
  "MediaCodec",
  "C2Store",
  "hw-BpHwBinder"
];

// Logcat is a firehose; filter agent-side and cap what reaches the client.
// Info and above. Verbose and Debug are two thirds of a stock device's output,
// so defaulting to them would spend tunnel bandwidth on lines nobody reads.
export const LOGCAT_DEFAULT_LEVEL = "I";

export const LOGCAT = {
  maxLineLength: 2000,
  batchMs: 250,          // coalesce lines into one message
  maxBatchLines: 200,
  backlogLines: 200      // lines of history a newly-opened panel receives
};

// APKs land here before `adb install`; removed right after.
export const APK_STAGE_DIR = "9remote-apk";
export const APK_MAX_BYTES = 500 * 1024 * 1024;

// Video preamble: 64B device name + 12B codec meta, plus an optional dummy byte.
export const PREAMBLE_SIZE = 64 + 12 + 1;
export const FRAME_HEADER_SIZE = 12;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_READER_BUFFER_BYTES = 32 * 1024 * 1024;

// App-level flow control. The WS tunnel accepts an emit long after the link is
// saturated — socket.io just grows its writeBuffer — so "did the send succeed"
// says nothing about whether the client can keep up. Without a window the pump
// runs at encoder speed while the tunnel drains far slower, and the backlog
// becomes tens of seconds of latency: the client waits forever for a frame that
// is queued behind stale ones. Mirrors the tiles path, which already does this.
export const FLOW = {
  // 4, not 2: the window caps throughput at ackWindow / rtt, and over a tunnel
  // (~150ms round trip) a window of 2 measured 11fps against 19fps at 4 — felt
  // as touch lag. 8 bought only 5% more, so 4 is where the encoder becomes the
  // limit again rather than the window.
  ackWindow: 4,          // frames in flight before the pump waits
  // Tighter than the old 20ms: this is dead time added to every frame once the
  // window is full, and at 20ms it was a tenth of the frame budget.
  ackPollMs: 8,          // re-check interval while waiting
  ackTimeoutMs: 1500,    // ack lost → assume dropped and resume, never deadlock
  // Consecutive ack timeouts that mean nobody is watching any more: a client can
  // vanish without sending mobile:stop (tab closed, reload, network drop), and
  // the encoder would otherwise keep running for no one.
  deadAckLimit: 8,
  pausePollMs: 200       // how often a paused pump re-checks for the viewer
};

// Adaptive bitrate. The client picks a frame size from its viewport, but only
// the agent can see whether the link actually carries it: a tunnel that cannot
// keep up leaves the encoder cramming every frame into a budget the wire never
// delivers, which is what makes the picture fall apart. Measured from how long
// frames sit unacknowledged, and applied by restarting the encoder — scrcpy
// has no way to change bitrate on a live session.
export const ADAPT = {
  sampleWindowMs: 4000,     // how much history a decision is made on
  minRestartGapMs: 15_000,  // never thrash the encoder
  // Fraction of the ack window spent full before the link counts as congested.
  congestedRatio: 0.5,
  healthyRatio: 0.1,
  stepDown: 0.7,            // multiply size by this when congested
  stepUp: 1.15,             // and creep back up when healthy
  minScale: 0.35,           // never shrink below this fraction of the request
  maxScale: 1
};

// Access units ride the transport's ordered "file" channel, which caps a message
// at the SCTP limit — so a keyframe is split across chunks and reassembled by
// frameSeq on the client. See mobileFrame.js for the exact layout.
export const VIDEO_CHUNK_PAYLOAD = 56 * 1024;

// scrcpy control message type codes (v3).
export const CONTROL_TYPE = {
  injectKeycode: 0,
  injectText: 1,
  injectTouch: 2,
  injectScroll: 3,
  backOrScreenOn: 4,
  resetVideo: 17
};

export const TOUCH_ACTION = { down: 0, up: 1, move: 2 };

// Android KeyEvent codes for the hardware buttons the UI exposes.
export const ANDROID_KEY = {
  home: 3,
  back: 4,
  power: 26,
  enter: 66,
  recents: 187,
  volumeUp: 24,
  volumeDown: 25
};

export const TEXT_MAX_BYTES = 300;
export const TAP_HOLD_MS = 20;
// Touch moves are injected at wall-clock spacing of at least this. The network
// bunches them; injected back-to-back they inflate Android's velocity tracker
// and a small swipe flings across the screen.
// 16ms meant ~60 input messages a second while a finger moved, and each one is
// a round trip over the control channel — enough to swamp a tunnel on its own.
// 33ms halves that; Android interpolates between motion events anyway, so the
// gesture still lands smoothly.
export const MOVE_MIN_INTERVAL_MS = 33;

// scrcpy's own scroll message: one 21-byte packet per scroll, versus the ~17
// touch packets a simulated swipe needs. hscroll/vscroll are fixed-point i16
// covering the range [-16, 16].
export const SCROLL_RANGE = 16;
export const SWIPE_MIN_MS = 80;
export const SWIPE_STEP_MS = 16;
export const SWIPE_MAX_MS = 10_000;
