// Transport channel + profile config (config-driven, DRY).
// Add new protocol = 1 entry in profiles.enabled + register adapter.

export const CHANNELS = {
  control: "control",
  binary: "binary",
  file: "file"
};

// SCTP DC max control payload — oversize messages throw / corrupt the channel.
// Route control payloads larger than this over WS (no SCTP limit).
export const CONTROL_RTC_MAX_BYTES = 65536;

// RTC zombie recovery — ack timeout (detect dead-but-open DC) + restart backoff.
export const RTC_RESTART = {
  ackTimeoutMs: 5000,        // ack not received → suspect zombie → restart
  maxAttempts: 3,            // give up after N restarts → WS owns
  backoffMs: [1000, 2000, 4000] // delay before each restart attempt
};

// WS zombie recovery — detect a socket.io socket that still reports connected
// after OS background suspension froze its pings (data never flows again).
// ~2 missed ping cycles (socket.io default pingInterval 25s) = certainly dead.
export const WS_ZOMBIE_MS = 45000;

// File-transfer tunables (DC "file", separate from tiles' dcBinary).
// chunkSize mirrors dcMaxMessageSize so each frame is one SCTP message (no split).
// dcBufferThreshold is generous (8MB) — file transfer is throughput, not real-time.
export const FILE_TRANSFER = {
  chunkSize: 64 * 1024,
  windowSize: 64,                 // pipelining: in-flight unacked chunks
  dcBufferThreshold: 8 * 1024 * 1024,
  maxUploadSize: 50 * 1024 * 1024, // per-file cap
  maxDownloadSize: 200 * 1024 * 1024, // folder-zip cap (sum of file sizes)
  maxStreamMediaSize: 500 * 1024 * 1024 // progressive MSE streaming cap (audio/video)
};

export const ADAPTER_STATE = {
  idle: "idle",
  connecting: "connecting",
  open: "open",
  degraded: "degraded",
  closed: "closed"
};

// Per-profile config — clientApp vs remoteDesktop độc lập
export const TRANSPORT_PROFILES = {
  clientApp: {
    enabled: ["ws", "rtc"],
    parallel: true,
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" },
      file: { strategy: "priority", prefer: "rtc" }
    },
    rtc: { enableTurn: false, dcControl: { ordered: true } }
  },
  remoteDesktop: {
    enabled: ["ws", "rtc"],
    parallel: true,
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" },
      file: { strategy: "priority", prefer: "rtc" }
    },
    rtc: { enableTurn: false, dcControl: { ordered: true } }
  }
};
