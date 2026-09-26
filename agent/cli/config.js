import chalk from "chalk";

// NODE_ENV=development only toggles local dev behavior (Vite proxy, logs) — the
// target zone stays prod. Override with NREMOTE_WORKER_URL=https://dev.9remote.cc.
const IS_DEV = process.env.NODE_ENV === "development";
export const IS_DEV_ENV = IS_DEV;
export const WORKER_URL = process.env.NREMOTE_WORKER_URL
  || (typeof __DEFAULT_WORKER_URL__ !== "undefined" ? __DEFAULT_WORKER_URL__ : "https://9remote.cc");
export const SERVER_HEALTHY_RESET_MS = 30000;
export const SHUTDOWN_EXIT_DELAY_MS = 500;
export const SHUTDOWN_CRASH_DELAY_MS = 300;

export const POLL = {
  cmdMs: 1000,
  pendingApprovalMs: 3000,
  statsMs: 5000,
  serverReadyIntervalMs: 200,
  serverReadyTimeoutMs: 5000,
  bgServerReadyTimeoutMs: 15000,
  bgServerReadyIntervalMs: 300,
};

export const HEALTH_CHECK = {
  intervalMs: 2000,
  timeoutMs: 120000,
  fetchTimeoutMs: 5000,
  dnsTimeoutMs: 2000,
  maxLogEntries: 80,
  postReadyHoldMs: 2000,
};

export const DELAYS = {
  killCloudflaredMs: 500,
  killCloudflaredTuiMs: 300,
  serverBootMs: 2000,
  // A second CLI that finds a live server re-checks after this before exiting —
  // must exceed the max graceful shutdown (500ms flush + 1.5s heartbeat), or a
  // server caught mid-shutdown (restart_agent) would read as alive.
  guestRecheckMs: 3000,
  trayReadyMs: 1000,
  postReadyHoldMs: 2000,
  bgSpawnFlushMs: 400,
};

// Minimum gap between two cloudflared spawns — trycloudflare rate-limits bursts
export const TUNNEL_SPAWN = { minGapMs: 3000 };

export const TUI = { maxLogLines: 200, headerWidth: 44 };

export const UPDATE = {
  checkIntervalMs: 3600000,
  connectCheckDebounceMs: 900000, // 15 min — throttle re-check on web connect
  maxRetry: 3,
  retryDelayMs: 3000,
  verifyTimeoutMs: 15000,
  lockTtlMs: 300000,
  lockFile: "update.lock",
  gateTimeoutMs: 60000, // loading gate dies on its own — orphan can never hold the port
};

export const URL_SYNC_DEBOUNCE_MS = 5000;
// How often the agent tells the Worker it is alive, and how long shutdown may
// wait for the final "offline" beat to flush before exiting anyway.
export const SESSION_HEARTBEAT_INTERVAL_MS = 120000;
export const HEARTBEAT_GOODBYE_MAX_MS = 1500;
export const HEALTH_FLAP_STABLE_CHECKS = 2;
export const FAST_PROBE_TIMEOUT_MS = 30000;

export const COLORS = {
  orange: chalk.rgb(230, 138, 110),
  orangeDim: chalk.rgb(200, 120, 95),
};
