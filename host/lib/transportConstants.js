// Transport channel + profile config (server side, mirror of web).

export const CHANNELS = {
  control: "control",
  binary: "binary",
  file: "file",
  mobile: "mobile"
};

// Control payload ceiling, used only when the DC cannot report the SCTP limit
// itself (libdatachannel exposes maxMessageSize()). Oversize envelopes are sliced
// by the adapter, not re-routed: the carrier is chosen from adapter state, never
// from the payload.
export const CONTROL_RTC_MAX_BYTES = 65536;

// Control-DC liveness (ttyd pattern: periodic ping, hang up after interval+grace
// of silence). SCTP can stay "open" while an app-level stall blackholes every
// message — with RTC carrying the whole terminal stream, this is the only
// detector for that. Mirrored in web/shared/constants/transport.js.
export const RTC_HEARTBEAT_INTERVAL_MS = 10_000;
export const RTC_HEARTBEAT_TIMEOUT_MS = 25_000;

// Device-approval answers sent over signaling. Mirrored in
// web/shared/constants/transport.js — the client maps these to its approval UI
// instead of treating them as a transport failure.
export const SIGNALING_ERRORS = {
  pending: "pending-approval",
  rejected: "device-rejected"
};

// What a connecting device is allowed to do — the only three answers
// decideAdmission gives, for every carrier.
export const ADMISSION = {
  admit: "admit",   // let it in
  hold: "hold",     // ask the host (modal / Clients list)
  reject: "reject"  // no, and no modal to override it
};

// The host's standing decision about a device (deviceApproval.gateDevice) —
// about WHO it is, independent of whether it can prove the key TAIL.
export const DEVICE_GATE = {
  approved: "approved",
  rejected: "rejected",
  auto: "auto",       // auto-approve is on
  unknown: "unknown"
};

// Where a device stands on the key-TAIL proof. Held per device, not per socket:
// WS and RTC are two carriers of one connection.
export const TAIL_VERDICT = {
  proving: "proving",   // inside the grace window, no proof yet
  proven: "proven",     // presented the right TAIL
  rejected: "rejected"  // presented a wrong one — see TAIL_REJECT_REASON
};

// Why a device was refused. Travels to the client in device:tailRejected, so
// these strings are wire format — mirrored in web/shared/constants/transport.js.
export const TAIL_REJECT_REASON = {
  mismatch: "mismatch",              // wrong TAIL — final, the user re-enters the key
  sealUnreadable: "seal-unreadable", // sealed to a key we don't hold (stale pin) — client drops the pin and retries plain
  timeout: "proof-timeout"           // never proved inside the grace window
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
      file: { strategy: "priority", prefer: "rtc" },
      mobile: { strategy: "priority", prefer: "rtc" }
    }
  },
  remoteDesktop: {
    enabled: ["ws", "rtc"],
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" },
      file: { strategy: "priority", prefer: "rtc" },
      mobile: { strategy: "priority", prefer: "rtc" }
    }
  }
};
