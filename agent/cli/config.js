import chalk from "chalk";

export const WORKER_URL = "https://9remote.cc";
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
  timeoutMs: 180000,
  fetchTimeoutMs: 5000,
  dnsTimeoutMs: 2000,
  maxLogEntries: 80,
  postReadyHoldMs: 2000,
};

export const DELAYS = {
  killCloudflaredMs: 500,
  killCloudflaredTuiMs: 300,
  serverBootMs: 2000,
  trayReadyMs: 1000,
  postReadyHoldMs: 2000,
  bgSpawnFlushMs: 400,
};

export const TUI = { maxLogLines: 200, headerWidth: 44 };

export const COLORS = {
  orange: chalk.rgb(230, 138, 110),
  orangeDim: chalk.rgb(200, 120, 95),
};
