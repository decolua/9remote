import dns from "dns";
import path from "path";
import os from "os";

// Centralized filesystem layout for ~/.9remote
// Group files by responsibility: logs / state / config
const ROOT = path.join(os.homedir(), ".9remote");
export const PATHS = {
  ROOT,
  LOGS:    path.join(ROOT, "logs"),
  STATE:   path.join(ROOT, "state"),
  CONFIG:  path.join(ROOT, "config"),
  BIN:     path.join(ROOT, "bin"),
  PIDS:    path.join(ROOT, "pids"),
  BUFFERS: path.join(ROOT, "buffers"),
  DAEMON:  path.join(ROOT, "daemon"),
};

// Force public DNS to bypass macOS mDNSResponder negative cache
// (new trycloudflare subdomains stuck NXDOMAIN until system TTL expires)
const publicResolver = new dns.promises.Resolver();
publicResolver.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const _originalLookup = dns.lookup;
const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$|^::1$|^[0-9a-f:]+$/i;
dns.lookup = (hostname, options, cb) => {
  if (typeof options === "function") { cb = options; options = {}; }
  if (hostname === "localhost" || IP_REGEX.test(hostname)) {
    return _originalLookup(hostname, options, cb);
  }
  publicResolver.resolve4(hostname).then((addrs) => {
    if (!addrs?.length) return _originalLookup(hostname, options, cb);
    if (options.all) cb(null, addrs.map((a) => ({ address: a, family: 4 })));
    else cb(null, addrs[0], 4);
  }).catch(() => _originalLookup(hostname, options, cb));
};

/**
 * Shared constants for agent server + CLI
 */

// Local agent HTTP server port (UI + API)
export const SERVER_PORT = 2208;

// Vite dev server port (dev-mode UI origin)
export const VITE_DEV_PORT = 5173;

// Allowed origins for the localhost UI (token endpoint + socket trust guard).
// A malicious cross-origin page sends a different Origin → rejected.
export const LOCAL_UI_ORIGINS = [
  `http://localhost:${SERVER_PORT}`,
  `http://127.0.0.1:${SERVER_PORT}`,
  `http://localhost:${VITE_DEV_PORT}`,
  `http://127.0.0.1:${VITE_DEV_PORT}`,
];

// Centralized log file config — single sink for console + crash + tunnel + remote
export const LOG_CONFIG = {
  fileName: "agent.log",
  rotatedName: "agent.log.1",
  maxBytes: 2 * 1024 * 1024,
  cleanupAfterDays: 7,
};

// Tail size for "View Logs" history (TUI + Web UI)
export const LOG_TAIL_LINES = 60;

// Connection step states (UI progress tracking)
export const STEP = {
  STOPPED: 0,
  PREPARING: 1,
  CONNECTING: 2,
  TUNNELING: 3,
  VERIFYING: 4,
  READY: 5,
};

// Debug flags — toggle diagnostic displays without touching logic
export const DEBUG = {
  showTunnelUrlInMenu: false,
};

// macOS permission poll — TCC has no change event, so we poll periodically.
// Fast cadence kicks in right after user clicks "Grant" so UI reflects the toggle quickly.
export const PERMISSION_POLL_MS = 5000;
export const PERMISSION_POLL_FAST_MS = 1000;
export const PERMISSION_POLL_FAST_DURATION = 60000;

// Claude Code uses fullscreen alternate-screen by default which breaks native scrollback
// Applied two ways: agent process env (loadEnv) + ~/.claude/settings.json (hookManager)
export const CLAUDE_SCROLLBACK_ENV = {
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
};

// Tunnel health watchdog — poll /api/health via the public tunnel URL
export const TUNNEL_HEALTH = {
  checkIntervalMs: 30000,
  requestTimeoutMs: 5000,
};

// Centralized retry/backoff config — never give up; each entry tuned per failure profile
// strategy: "exp" (2^n) for crash-prone loops; "linear" for transient API/network blips
export const RETRY_CONFIG = {
  server:        { strategy: "exp",    baseMs: 1000, maxMs: 60000  },
  tunnelRestart: { strategy: "exp",    baseMs: 2000, maxMs: 300000 },
  tunnelSpawn:   { strategy: "linear", baseMs: 5000, maxMs: 60000  },
  internet:      { strategy: "linear", baseMs: 3000, maxMs: 60000  },
  sse:           { strategy: "linear", baseMs: 2000, maxMs: 2000   },
  urlSync:       { strategy: "linear", baseMs: 5000, maxMs: 60000  },
};

// Browser-like headers to avoid CDN/firewall blocks
const BROWSER_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

/**
 * fetch() wrapper with browser-like headers for external requests
 */
export function browserFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...BROWSER_HEADERS, ...options.headers },
  });
}
