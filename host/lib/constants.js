import dns from "dns";
import path from "path";
import os from "os";

// Centralized filesystem layout for ~/.9remote
// Group files by responsibility: logs / state / config
// Build-time injected name (__PKG_NAME__) wins; env override for source runs; default 9remote
export const PACKAGE_NAME = (typeof __PKG_NAME__ !== "undefined" && __PKG_NAME__) || process.env.NREMOTE_PKG || "9remote";
// Registry override for local testing (Verdaccio). Falls back to public npm.
export const NPM_REGISTRY_URL = process.env.NREMOTE_REGISTRY || `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const NPM_INSTALL_SPEC = `${PACKAGE_NAME}@latest`;

// NREMOTE_HOME relocates the whole root (socket, daemon copy, snapshots) so a test
// or a second instance can run without fighting the live host for the socket.
const ROOT = process.env.NREMOTE_HOME || path.join(os.homedir(), ".9remote");
export const PATHS = {
  ROOT,
  LOGS:    path.join(ROOT, "logs"),
  STATE:   path.join(ROOT, "state"),
  CONFIG:  path.join(ROOT, "config"),
  BIN:     path.join(ROOT, "bin"),
  PIDS:    path.join(ROOT, "pids"),
  BUFFERS: path.join(ROOT, "buffers"),
  DAEMON:  path.join(ROOT, "daemon"),
  AI_SESSIONS: path.join(ROOT, "ai-sessions"),
  BACKGROUNDS: path.join(ROOT, "backgrounds"),
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
  const resolve = async () => {
    if (options.family === 6) {
      const addrs = await publicResolver.resolve6(hostname);
      return { addrs, family: 6 };
    }
    if (options.family === 4) {
      const addrs = await publicResolver.resolve4(hostname);
      return { addrs, family: 4 };
    }
    const [res4, res6] = await Promise.allSettled([
      publicResolver.resolve4(hostname),
      publicResolver.resolve6(hostname),
    ]);
    if (res4.status === "fulfilled" && res4.value?.length) return { addrs: res4.value, family: 4 };
    if (res6.status === "fulfilled" && res6.value?.length) return { addrs: res6.value, family: 6 };
    return null;
  };
  resolve().then((res) => {
    if (!res?.addrs?.length) return _originalLookup(hostname, options, cb);
    if (options.all) cb(null, res.addrs.map((a) => ({ address: a, family: res.family })));
    else cb(null, res.addrs[0], res.family);
  }).catch(() => _originalLookup(hostname, options, cb));
};

/**
 * Shared constants for host server + CLI
 */

// Local host HTTP server port (UI + API)
export const SERVER_PORT = 2208;

// Spawn children with the running interpreter: a Finder-launched app has a bare
// PATH, so literal "node" is not found. Under Electron, its Node needs the flag.
export const NODE_BIN = process.execPath;
export const nodeSpawnEnv = (env = process.env) =>
  process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : { ...env };

// A child spawned from the Electron bundle gets its own Dock icon: macOS sees
// execPath inside the .app and registers it as a second application. Demote it.
export async function hideDockIcon() {
  if (process.platform !== "darwin" || !process.versions.electron) return;
  try {
    const koffi = (await import("koffi")).default;
    const lib = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
    const PSN = koffi.struct("ProcessSerialNumber", { highLongOfPSN: "uint32", lowLongOfPSN: "uint32" });
    const transform = lib.func("TransformProcessType", "int", [koffi.pointer(PSN), "int"]);
    transform([{ highLongOfPSN: 0, lowLongOfPSN: 2 }], 4); // kCurrentProcess → UIElement
  } catch {}
}

// Vite dev server port (dev-mode UI origin)
export const VITE_DEV_PORT = 5173;

// Next dev server port (web UI in a dev checkout)
export const WEB_DEV_PORT = 3000;

// Reserved deviceId for the trusted local UI — never persisted/tracked as a client.
export const LOCAL_UI_DEVICE_ID = "local-ui";

// Allowed origins for the localhost UI (token endpoint + socket trust guard).
// A malicious cross-origin page sends a different Origin → rejected.
// Every entry is loopback: the port differs per UI (host, Vite, Next dev) but
// the machine does not. These are ports, not a trust decision — the checks that
// matter are the key TAIL and, for /api/ui/state, that the request arrived over
// loopback with a local Host (see middleware/cors.js). Gating these on
// NODE_ENV instead would make a production install reject its own dev UI.
export const LOCAL_UI_ORIGINS = [
  `http://localhost:${SERVER_PORT}`,
  `http://127.0.0.1:${SERVER_PORT}`,
  `http://localhost:${VITE_DEV_PORT}`,
  `http://127.0.0.1:${VITE_DEV_PORT}`,
  `http://localhost:${WEB_DEV_PORT}`,
  `http://127.0.0.1:${WEB_DEV_PORT}`,
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
// Applied two ways: host process env (loadEnv) + ~/.claude/settings.json (hookManager)
export const CLAUDE_SCROLLBACK_ENV = {
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
};

// Supported AI CLI tools for notification hooks — single source of truth
export const AI_TOOLS = ["claude", "codex", "opencode", "grok", "cursor", "antigravity", "kiro", "copilot", "codebuddy", "factory", "qoder", "rovodev", "hermes", "amp", "pi", "omp", "devin"];
export const TOOL_LABELS = { claude: "Claude", codex: "Codex", opencode: "OpenCode", grok: "Grok", cursor: "Cursor", antigravity: "Antigravity", kiro: "Kiro", copilot: "Copilot", codebuddy: "CodeBuddy", factory: "Factory", qoder: "Qoder", rovodev: "Rovo Dev", hermes: "Hermes", amp: "Amp", pi: "Pi", omp: "OMP" };

// MCP endpoint served by the host's own HTTP server — no extra process to spawn.
// One tool: the AI names a file it just made, the app slides it in beside the terminal.
export const MCP = {
  SERVER_NAME: "9remote",
  PROTOCOL_VERSION: "2024-11-05",
  PATH: "/mcp",
  // On by default: the AI can show a file the moment the app is installed
  DEFAULT_ENABLED: true,
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
  // trycloudflare rate-limits account-less tunnel creation — retrying every few
  // seconds keeps the block alive, so back off in minutes instead.
  tunnelRateLimit: { strategy: "exp",  baseMs: 60000, maxMs: 900000 },
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
