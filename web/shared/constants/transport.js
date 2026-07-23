// Transport channel + profile config (config-driven, DRY).
// Add new protocol = 1 entry in profiles.enabled + register adapter.

export const CHANNELS = {
  control: "control",
  binary: "binary"
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
      binary: { strategy: "priority", prefer: "rtc" }
    },
    rtc: { enableTurn: false, dcControl: { ordered: true } }
  },
  remoteDesktop: {
    enabled: ["ws", "rtc"],
    parallel: true,
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" }
    },
    rtc: { enableTurn: false, dcControl: { ordered: true } }
  }
};
