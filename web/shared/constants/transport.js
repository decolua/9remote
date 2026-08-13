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
  maxAttempts: 3,            // fast-retry count before switching to slow probe
  backoffMs: [500, 1500, 3000], // delay before each fast restart attempt (tight: answer normally <300ms)
  // Escalating probe cadence after the fast phase — each P2P retry is a DO
  // signaling round-trip, so back off instead of a fixed 30s forever.
  probeBackoffMs: [30000, 60000, 120000, 300000],
  // After this many failed probes, classify NAT; "hard" → give up RTC (WS-only)
  // and stop spending DO calls until the network changes.
  classifyAfterProbes: 3
};

// Standalone STUN probe used to lift an RTC give-up. A resume only re-arms RTC
// when the public IP actually changed (real network handover) — a timer would
// re-spam the DO on every long app switch even though the NAT never moved.
// This talks to public STUN only: no DO call, no agent involvement.
export const STUN_PROBE = {
  urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
  timeoutMs: 2500,
  // Don't re-probe more often than this — resume can fire in bursts.
  minIntervalMs: 15000
};

// Resume grace: when WS reconnects while RTC is mid-handshake (typical after
// background resume — tunnel WS beats RTC ICE gather), wait this long for RTC
// to open before resetting the terminal. If RTC opens → transparent switch, no
// flicker. If not → fall back to a WS-driven rejoin to recover content.
export const REJOIN_DEBOUNCE_MS = 500;

// Max time RTC stays "connecting" before we give up. Without this, an offer that
// reached the DO before the agent joined its room is silently dropped — no answer
// ever arrives, ICE never runs, and the adapter hangs in "connecting" forever
// (only "ice failed" closes it, and ICE never starts without an answer). On
// timeout, close → PM._scheduleRtcRestart fires → re-offer; by retry 2-3 the
// agent has usually joined the signaling room and RTC opens.
export const RTC_CONNECT_TIMEOUT_MS = 4000;

// Resume-from-background probe window: after the OS suspends the tab,
// iceConnectionState events are deferred, so RTC may still report "open" while
// actually dead. On resume we sample getStats() across this window and check
// whether the selected ICE pair's responsesReceived grew (STUN keepalives flow
// on a live DC). No growth → zombie → force a full restart without waiting the
// ~30s for ICE "failed". Browser-only — no agent cooperation needed. Keep
// short: WS carries data during the probe.
export const RESUME_PROBE_TIMEOUT_MS = 2000;

// DO signaling relay — fallback carrier for RTC signaling when tunnel WS is
// down/not ready. Same-origin endpoint (wss://<host>/signaling), apiKey-gated.
export const SIGNALING_CONFIG = {
  enabled: true,
  pingMs: 25000 // Hibernation auto-response — never wakes the DO, never billed
};

// Signaling errors that mean "the agent heard you, but the device isn't cleared"
// — a policy answer, not a transport failure. Mirrored in agent/lib/transportConstants.js.
// The client must show the approval UI instead of retrying/falling back.
export const SIGNALING_ERRORS = {
  pending: "pending-approval",
  rejected: "device-rejected"
};

// Network-change recovery. `online`/`connection.change` are only hints (MDN:
// onLine is "inherently unreliable"; Network Information API is absent on
// Safari), so they merely trigger a probe — the srflx IP below is the truth.
export const NET_RECOVERY = {
  debounceMs: 500 // connection.change fires in bursts on handover
};

// WS zombie recovery — detect a socket.io socket that still reports connected
// after OS background suspension froze its pings (data never flows again).
// ~2 missed ping cycles (socket.io default pingInterval 25s) = certainly dead.
export const WS_ZOMBIE_MS = 45000;

// File-transfer tunables (DC "file", separate from tiles' dcBinary).
// chunkSize + 8-byte frame header must fit dcMaxMessageSize (SCTP hard limit).
// dcBufferThreshold is generous (8MB) — file transfer is throughput, not real-time.
const FILE_FRAME_HEADER_SIZE = 8; // [uploadId u32][offset u32] — see fileFrame.js
export const FILE_TRANSFER = {
  chunkSize: 64 * 1024 - FILE_FRAME_HEADER_SIZE,
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
