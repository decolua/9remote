// Transport channel + profile config (server side, mirror of web).

export const CHANNELS = {
  control: "control",
  binary: "binary",
  file: "file"
};

// SCTP DC max control payload — oversize messages throw / corrupt the channel.
// Route control payloads larger than this over WS (no SCTP limit).
export const CONTROL_RTC_MAX_BYTES = 65536;

// Device-approval answers sent over signaling. Mirrored in
// web/shared/constants/transport.js — the client maps these to its approval UI
// instead of treating them as a transport failure.
export const SIGNALING_ERRORS = {
  pending: "pending-approval",
  rejected: "device-rejected"
};

// How long an RTC-only session survives a dead peer before it's torn down.
// The client renegotiates over DO after a resume/handover (backoff up to 4s),
// so tearing down sooner would unregister the handler its re-offer needs.
export const RTC_DEAD_GRACE_MS = 15000;

export const ADAPTER_STATE = {
  idle: "idle",
  connecting: "connecting",
  open: "open",
  degraded: "degraded",
  closed: "closed"
};

// File-transfer tunables (DC "file", separate from tiles' dcBinary).
// chunkSize + 8-byte frame header must fit dcMaxMessageSize (SCTP hard limit).
// dcBufferThreshold is generous (8MB) — file transfer is throughput, not real-time.
const FILE_FRAME_HEADER_SIZE = 8; // [uploadId u32][offset u32] — see fileFrame.js
export const FILE_TRANSFER = {
  chunkSize: 64 * 1024 - FILE_FRAME_HEADER_SIZE,
  windowSize: 64,                 // pipelining: in-flight unacked chunks
  dcBufferThreshold: 8 * 1024 * 1024,
  maxUploadSize: 50 * 1024 * 1024, // per-file cap (feature-side also enforces)
  maxDownloadSize: 200 * 1024 * 1024, // folder-zip cap (sum of file sizes)
  maxStreamMediaSize: 500 * 1024 * 1024 // progressive MSE streaming cap (audio/video)
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
