// Transport channel + profile config (server side, mirror of web).

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

export const TRANSPORT_PROFILES = {
  clientApp: {
    enabled: ["ws", "rtc"],
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" }
    }
  },
  remoteDesktop: {
    enabled: ["ws", "rtc"],
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" }
    }
  }
};
