// Transport channel + profile config (config-driven, DRY).
// Thêm protocol mới = 1 entry trong profiles.enabled + register adapter.

export const CHANNELS = {
  control: "control",
  binary: "binary"
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
