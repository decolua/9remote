// Transport channel + profile config (server side, mirror of web).

export const CHANNELS = {
  control: "control",
  binary: "binary",
  file: "file"
};

// SCTP DC max control payload — oversize messages throw / corrupt the channel.
// Route control payloads larger than this over WS (no SCTP limit).
export const CONTROL_RTC_MAX_BYTES = 65536;

export const ADAPTER_STATE = {
  idle: "idle",
  connecting: "connecting",
  open: "open",
  degraded: "degraded",
  closed: "closed"
};

// File-transfer tunables (DC "file", separate from tiles' dcBinary).
// chunkSize mirrors dcMaxMessageSize so each frame is one SCTP message (no split).
// dcBufferThreshold is generous (8MB) — file transfer is throughput, not real-time.
export const FILE_TRANSFER = {
  chunkSize: 64 * 1024,
  windowSize: 64,                 // pipelining: in-flight unacked chunks
  dcBufferThreshold: 8 * 1024 * 1024,
  maxUploadSize: 50 * 1024 * 1024, // per-file cap (feature-side also enforces)
  maxDownloadSize: 200 * 1024 * 1024 // folder-zip cap (sum of file sizes)
};

export const TRANSPORT_PROFILES = {
  clientApp: {
    enabled: ["ws", "rtc"],
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" },
      file: { strategy: "priority", prefer: "rtc" }
    }
  },
  remoteDesktop: {
    enabled: ["ws", "rtc"],
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" },
      file: { strategy: "priority", prefer: "rtc" }
    }
  }
};
