// Feature flags — toggle features without touching logic
export const FEATURES = {
  localFirstConnection: false,  // Probe LAN before tunnel
};

// Behavior config — tunable parameters
export const BEHAVIOR = {
  retry: { interval: 2000, maxAttempts: 15, savedKeyMaxAttempts: 3, reconnectMaxAttempts: 15, updateReconnectMaxAttempts: 45 },
  reconnect: { fastFailThreshold: 3 },
};
