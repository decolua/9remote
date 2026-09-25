/**
 * Server entry point - config-driven HTTP router + Socket.IO
 */

import { createServer, request as httpRequest } from "http";
import { execFile, execSync, spawn } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";
import { join, extname, sep } from "path";
import { fileURLToPath, parse } from "url";
import chalk from "chalk";

import { createRouter, jsonOk, jsonErr } from "./lib/router.js";
import { isSitesHost, routeSitesLocalRequest } from "./lib/sitesHost.js";
import { STEP, browserFetch, PERMISSION_POLL_MS, NPM_REGISTRY_URL, hideDockIcon, MCP } from "./lib/constants.js";
import { initLogger, createLogger } from "./lib/logger.js";

hideDockIcon();
initLogger();
const logger = createLogger("server");
import { startTransportServer, getIO } from "./transport/server.js";
import { createProxyServer, handleProxyRequest, startProxySession, endProxySession } from "./proxy/index.js";
import { handlePreviewRequest } from "./features/fileExplorer/previewServer.js";
import { initializeTerminal } from "./features/terminal/terminalSocket.js";
import { handleLocalSites } from "./api/localSites.js";
import { matchesLocalKey } from "./cli/utils/apiKey.js";
import { generateLocalToken } from "./lib/localToken.js";
import { isNewerVersion } from "./cli/utils/updateChecker.js";

import {
  loadUiState, loadDesktopState, refreshPermissionsAsync, pushUiEvent, setRemoteAvailable,
  handleSseEvents, handleStateGet, handleStatePost,
  handleStop, handleStart, handleStopTunnel, handleShutdown,
  handleConnections, handleDesktopToggle, handleRtcToggle, handleLogsGet, handleLogsClear,
  handlePermissionsGet, handlePermissionsRequest,
  handleAutoStartGet, handleAutoStartPost,
  handleLocalToken, handleUpdate, setUpdateInfo, getUpdateInfo,
} from "./api/ui.js";
import { broadcastServerInfo, setConnectCheckHandler } from "./features/terminal/terminalSocket.js";
import { UPDATE } from "./cli/config.js";
import { handleOneTimeKey, handleRegenerate, handleSignalingRetry } from "./api/key.js";
import { handleApprove, handleReject, handlePending, handleApproved, handleRemove, handleDisconnect, handleRejected, handleApproveRejected, handleClearRejected, handleGetAutoApprove, handleSetAutoApprove, handleSetLabel } from "./api/device.js";
import { handleNotifyPost, handleNotifyGet } from "./api/notify.js";
import { handleMcpPost } from "./api/mcp.js";
import { handleSleepInhibitGet, handleSleepInhibitPost } from "./api/sleepInhibit.js";
import { handleRemoteEnabledGet, handleRemoteEnabledPost } from "./api/remote.js";
import { handleDesktopUnlockGet, handleDesktopUnlockInstall, handleDesktopUnlockType, handleDesktopUnlockUninstall } from "./api/desktopUnlock.js";
import { handleSessionsList, handleSessionDelete } from "./api/sessions.js";
import { handleSystemStats } from "./api/system.js";
import * as sleepInhibitor from "./lib/sleepInhibitor.js";
import { loadSettings, loadKey } from "./cli/utils/state.js";
import { REMOTE_CONFIG } from "./features/remote/REMOTE_CONFIG.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const IS_DEV = process.env.NODE_ENV === "development";
const VITE_PORT = 5173;

const UI_DIST = [
  join(__dirname, "dist", "ui"),
  join(__dirname, "ui", "dist"),
  join(__dirname, "ui"),
].find((d) => existsSync(d)) || join(__dirname, "dist", "ui");

const WEB_DIST = [
  join(__dirname, "dist", "web"),
  join(__dirname, "web"),
  join(__dirname, "..", "web", "out"),
].find((d) => existsSync(d)) || UI_DIST;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/x-component; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// ── Static / Dev helpers ─────────────────────────────────────────

function proxyToVite(req, res, fallbackFn) {
  const proxy = httpRequest(
    { hostname: "localhost", port: VITE_PORT, path: req.url, method: req.method, headers: req.headers },
    (proxyRes) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); }
  );
  proxy.on("error", () => fallbackFn ? fallbackFn() : (() => { res.writeHead(502); res.end("Vite dev server not ready"); })());
  req.pipe(proxy);
}

// The sites host serves the proxy shell, the worker and the browse scope from
// the embedded web build, and nothing else. Unknown paths are refused before
// the router, so none of the local API is reachable from here even by accident.
// The embedded build answers a bare GET, so the file's own Content-Type is what
// the shell and the worker need — except that the router's blanket
// X-Frame-Options would refuse to let the app frame the shell.
function serveSitesHost(req, res) {
  let parsed;
  try { parsed = parse(req.url).pathname; }
  catch { jsonErr(res, 400, "Bad request"); return; }
  const route = routeSitesLocalRequest(parsed, req.headers.host);
  if (!route) { jsonErr(res, 404, "Not found"); return; }
  for (const [key, value] of Object.entries(route.headers)) res.setHeader(key, value);
  if (serveStatic(res, join(WEB_DIST, route.path), { frameable: true })) return;
  jsonErr(res, 404, "Not found");
}

function serveStatic(res, filePath, { frameable = false } = {}) {
  if (!existsSync(filePath)) return false;
  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      const indexFile = join(filePath, "index.html");
      if (existsSync(indexFile)) return serveStatic(res, indexFile, { frameable });
      return false;
    }
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    // The agent-served pages auto-log-in and can drive a shell — they must
    // never be framable by another origin (clickjacking + keystroke injection).
    // The sites host is the exception: its shell is framed by the app on
    // purpose, and it holds no credential of its own to be framed for.
    if (ext === ".html" && !frameable) res.setHeader("X-Frame-Options", "SAMEORIGIN");
    // Hashed build assets are immutable; everything else (HTML, RSC .txt) must
    // revalidate or a stale bundle keeps running after an agent update.
    const immutable = filePath.includes(`${sep}_next${sep}static${sep}`);
    // A caller that already decided this file's caching (the sites host) keeps it.
    if (!res.hasHeader("Cache-Control")) {
      res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    }
    res.writeHead(200);
    res.end(readFileSync(filePath));
    return true;
  } catch {
    return false;
  }
}

async function checkForUpdate(currentVersion) {
  try {
    const res = await browserFetch(NPM_REGISTRY_URL);
    if (!res.ok) return;
    const { version } = await res.json();
    if (version && isNewerVersion(currentVersion, version)) {
      setUpdateInfo({ version });
      pushUiEvent("updateAvailable", { version });
      broadcastServerInfo();
      return;
    }
    // Registry is not ahead (fresh install, yanked/rolled-back release) — clear
    // the standing notice. Without this the flag could only ever turn ON, so a
    // client reconnecting to this process would keep showing the update pill.
    if (getUpdateInfo()) {
      setUpdateInfo(null);
      broadcastServerInfo();
    }
  } catch { /* non-critical */ }
}

// Re-check on web connect, debounced so many tabs/reconnects don't spam the registry
let lastConnectCheckAt = 0;
function checkForUpdateOnConnect(currentVersion) {
  const now = Date.now();
  if (now - lastConnectCheckAt < UPDATE.connectCheckDebounceMs) return;
  lastConnectCheckAt = now;
  checkForUpdate(currentVersion);
}

// ── Codespace handler ────────────────────────────────────────

function handleCodespaceStop(req, res) {
  if (process.env.CODESPACES !== "true") { jsonErr(res, 400, "Not running on Codespaces"); return; }
  const name = process.env.CODESPACE_NAME;
  if (!name) { jsonErr(res, 400, "Codespace name not found"); return; }
  const io = getIO();
  if (io) io.emit("codespace:stopping");
  jsonOk(res, { success: true, message: "Stopping codespace..." });
  setTimeout(() => execFile("gh", ["codespace", "stop", "-c", name], { windowsHide: true }), 500);
}

// ── Key verification (pre-login) ──────────────────────────────────────────

/**
 * Answer "is this the right TAIL?" before the client commits to a session.
 *
 * The Worker cannot answer it — it holds only the HEAD, deliberately — so the
 * question has to reach the agent, and this is the cheapest road there: one
 * request over the tunnel, no socket, no session, nothing to tear down if the
 * answer is no. It exists so a wrong key is refused AT THE LOGIN SCREEN rather
 * than after the user has been sent to a workspace they cannot use.
 *
 * It is a convenience, not the gate. The real check still happens on every
 * connection (lib/deviceAuth.admissionGate): a client could skip this endpoint
 * entirely and would get exactly as far. That is why answering it is safe —
 * it reveals nothing a connection attempt would not, and it is rate-limited by
 * the same counter, so it cannot be used to guess faster than connecting can.
 */
async function handleVerifyKey(req, res) {
  const { parseJsonBody } = await import("./lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;

  const { verifyPresentedTail } = await import("./lib/deviceAuth.js");
  const result = verifyPresentedTail({ tail: data.tail, tempKey: data.tempKey });
  if (result.ok) { jsonOk(res, { ok: true }); return; }
  // logger, not pushUiLog: the SSE-only push is lost to any UI that opens
  // after the attempt, while the logger line persists (file + /logs + SSE).
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  if (data.tempKey && data.tail) {
    // One strike, same as a carrier proof: a wrong TAIL on the LIVE code burned
    // it above, so the UI must stop showing a key that can never work again.
    // pairingUsed blocks the auto-mint — a fresh code is a deliberate host action.
    if (result.burned) {
      logger.warn(`wrong one-time code TAIL (${ip}) — code burned, clearing from UI`);
      const { clearOneTimeKey } = await import("./api/ui.js");
      clearOneTimeKey();
    } else {
      // Stale code rejected without burning — the live code on screen still works.
      logger.warn(`stale one-time code TAIL (${ip}) — code still live`);
    }
  } else if (data.tempKey) {
    logger.warn(`wrong one-time code TAIL (${ip}) — no TAIL presented, code still live`);
  } else {
    logger.warn(`wrong API-key TAIL (${ip}) — rejected`);
  }
  // The delay is the rate limiter's, applied here as it is on a connection:
  // guessing must not be cheaper through this door than through that one.
  setTimeout(() => jsonOk(res, { ok: false, reason: result.reason }), result.penaltyMs || 0);
}

// ── Proxy handlers ────────────────────────────────────────────

let proxyServer;

async function handleProxyStartEnd(req, res, { pathname }) {
  // Against the key this agent holds — a shape check would let any string
  // matching the v2 pattern open a proxy session to any loopback port.
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ") || !matchesLocalKey(authHeader.slice(7), loadKey()?.key)) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const { parseJsonBody } = await import("./lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  if (!data.port) { jsonErr(res, 400, "Port required"); return; }
  if (!pathname.endsWith("start")) {
    endProxySession(data.port);
    jsonOk(res, { success: true });
    return;
  }
  // The caller cannot derive the URL any more — hand back the id it needs.
  const sessionId = startProxySession(data.port);
  if (!sessionId) { jsonErr(res, 400, "Invalid port"); return; }
  jsonOk(res, { success: true, sessionId });
}

function handleProxy(req, res, { pathname, search }) {
  // A session id, not a port — see proxy/index.js. Ports were guessable and
  // this route is public.
  const match = pathname.match(/^\/proxy\/([0-9a-f-]{36})(\/.*)?$/);
  if (match) {
    handleProxyRequest(proxyServer, req, res, match[1], match[2] || "/", search);
  } else {
    jsonErr(res, 404, "Not found");
  }
}

// HTML file preview — static serving of the file's directory behind a session id.
function handlePreview(req, res, ctx) {
  handlePreviewRequest(req, res, ctx);
}

// ────────────────────────────────────────────────────────────────────────────
// ROUTE TABLE — single source of truth for all HTTP endpoints
// public: true = accessible via tunnel, false/omit = localhost-only
// ────────────────────────────────────────────────────────────────────────────

const ROUTES = [
  // Public routes (accessible via tunnel)
  { path: "/api/health",           method: "GET",  public: true, handler: (req, res) => jsonOk(res, { status: "ok", timestamp: Date.now() }) },
  { path: "/api/version",          method: "GET",  public: true, handler: (req, res) => {
    const version = typeof __CLI_VERSION__ !== "undefined"
      ? __CLI_VERSION__
      : JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version;
    res.setHeader("Cache-Control", "no-store");
    jsonOk(res, { version });
  }},
  { path: "/api/notify",           method: "POST", public: true, handler: handleNotifyPost },
  { path: "/api/notify",           method: "GET",  public: true, handler: handleNotifyGet },
  { path: "/proxy/*",              method: "*",    public: true, handler: handleProxy },
  { path: "/preview/*",            method: "GET",  public: true, handler: handlePreview },

  // UI state & SSE (localhost-only)
  { path: "/api/ui/events",        method: "GET",  handler: handleSseEvents },
  { path: "/api/local-token",      method: "GET",  handler: handleLocalToken },
  // MCP: the AI CLI runs on this host, so the endpoint stays localhost-only (+ bearer token)
  { path: MCP.PATH,                method: "POST", handler: handleMcpPost },
  { path: "/api/ui/state",         method: "GET",  handler: handleStateGet },
  { path: "/api/ui/state",         method: "POST", handler: handleStatePost },
  { path: "/api/ui/stop",          method: "POST", handler: handleStop },
  { path: "/api/ui/start",         method: "POST", handler: handleStart },
  { path: "/api/ui/stop-tunnel",   method: "POST", handler: handleStopTunnel },
  { path: "/api/ui/shutdown",      method: "POST", handler: handleShutdown },
  { path: "/api/update",           method: "POST", handler: handleUpdate },
  { path: "/api/system/stats",     method: "GET",  handler: handleSystemStats },

  // Key management (localhost-only)
  { path: "/api/key/one-time",     method: "POST", handler: handleOneTimeKey },
  { path: "/api/key/regenerate",   method: "POST", handler: handleRegenerate },
  { path: "/api/signaling/retry",  method: "POST", handler: handleSignalingRetry },

  // Device approval (localhost-only)
  { path: "/api/device/approve",        method: "POST", handler: handleApprove },
  { path: "/api/device/reject",         method: "POST", handler: handleReject },
  { path: "/api/device/pending",        method: "GET",  handler: handlePending },
  { path: "/api/device/approved",       method: "GET",  handler: handleApproved },
  { path: "/api/device/rejected",       method: "GET",  handler: handleRejected },
  { path: "/api/device/approve-rejected", method: "POST", handler: handleApproveRejected },
  { path: "/api/device/clear-rejected", method: "POST", handler: handleClearRejected },
  { path: "/api/device/remove",         method: "POST", handler: handleRemove },
  { path: "/api/device/label",          method: "POST", handler: handleSetLabel },
  { path: "/api/device/disconnect",     method: "POST", handler: handleDisconnect },
  { path: "/api/device/auto-approve",   method: "GET",  handler: handleGetAutoApprove },
  { path: "/api/device/auto-approve",   method: "POST", handler: handleSetAutoApprove },

  // System (localhost-only)
  { path: "/api/connections",      method: "GET",  handler: handleConnections },
  { path: "/api/logs",             method: "GET",  handler: handleLogsGet },
  { path: "/api/logs/clear",       method: "POST", handler: handleLogsClear },
  { path: "/api/permissions",      method: "GET",  handler: handlePermissionsGet },
  { path: "/api/permissions/request", method: "POST", handler: handlePermissionsRequest },
  { path: "/api/desktop/toggle",   method: "POST", handler: handleDesktopToggle },
  { path: "/api/ui/rtc-toggle",    method: "POST", handler: handleRtcToggle },
  { path: "/api/autostart",        method: "GET",  handler: handleAutoStartGet },
  { path: "/api/autostart",        method: "POST", handler: handleAutoStartPost },
  { path: "/api/sleep-inhibit",    method: "GET",  handler: handleSleepInhibitGet },
  { path: "/api/sleep-inhibit",    method: "POST", handler: handleSleepInhibitPost },
  { path: "/api/remote/enabled",   method: "GET",  handler: handleRemoteEnabledGet },
  { path: "/api/remote/enabled",   method: "POST", handler: handleRemoteEnabledPost },
  { path: "/api/desktop-unlock",   method: "GET",  handler: handleDesktopUnlockGet },
  { path: "/api/desktop-unlock/install", method: "POST", handler: handleDesktopUnlockInstall },
  { path: "/api/desktop-unlock/uninstall", method: "POST", handler: handleDesktopUnlockUninstall },
  { path: "/api/desktop-unlock/type",    method: "POST", handler: handleDesktopUnlockType },
  { path: "/api/sessions",         method: "GET",  handler: handleSessionsList },
  { path: "/api/sessions/delete",  method: "POST", handler: handleSessionDelete },
  { path: "/api/local-sites",      method: "*",    public: true, handler: handleLocalSites },
  { path: "/api/codespace/stop",   method: "POST", handler: handleCodespaceStop },

  // Proxy session management (tunnel-accessible, requires API key)
  // Pre-login key check — public because the client has no session yet; the
  // TAIL it presents is the credential, and a wrong one is all it gets back.
  { path: "/api/verify-key",       method: "POST", public: true, handler: handleVerifyKey },

  { path: "/api/proxy/start",      method: "POST", public: true, handler: handleProxyStartEnd },
  { path: "/api/proxy/end",        method: "POST", public: true, handler: handleProxyStartEnd },
];

// ── Server bootstrap ───────────────────────────────────────────────────────

const hostname = "localhost";
const port = parseInt(process.env.PORT || "2208", 10);

// Auto-start Vite dev server in dev mode
let viteProcess = null;
// Kill leaked vite from crashed/hard-killed dev restarts (orphaned → reparented to launchd)
function reapOrphanVite(configPath) {
  if (process.platform === "win32") return;
  try {
    const pids = execSync(`pgrep -f "vite --config ${configPath}"`, { encoding: "utf8" }).trim();
    for (const pid of pids.split("\n").filter(Boolean)) {
      const ppid = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8" }).trim();
      if (ppid === "1") { try { process.kill(Number(pid)); } catch {} } // esbuild child dies with vite
    }
  } catch {}
}
function startViteDev() {
  if (!IS_DEV) return;
  const viteConfigPath = join(__dirname, "vite.config.js");
  if (!existsSync(viteConfigPath)) return;
  reapOrphanVite(viteConfigPath);
  const viteBin = existsSync(join(__dirname, "node_modules", ".bin", "vite"))
    ? join(__dirname, "node_modules", ".bin", "vite")
    : join(__dirname, "..", "node_modules", ".bin", "vite");
  viteProcess = spawn("node", [viteBin, "--config", viteConfigPath], {
    cwd: __dirname,
    stdio: "ignore",
    detached: false,
  });
  viteProcess.on("error", () => {});
  viteProcess.unref();
}

export async function startServer() {
  // Persisted setting overrides default mode. Migrate legacy boolean → mode.
  const settings = loadSettings();
  let mode = settings.sleepInhibitMode;
  if (!mode) {
    if (settings.sleepInhibit === false) mode = "none"; // legacy off → do not block sleep
    else mode = REMOTE_CONFIG.sleepInhibit?.defaultMode || "never";
  }
  sleepInhibitor.setMode(mode);
  // Startup does NOT touch the desktop-unlock worker: no build, no spawn, no
  // stop, no UAC. The AtStartup scheduled task restores the worker after every
  // reboot, and install() rebuilds when the user toggles On — the only two
  // moments where touching it is warranted.
  await initializeTerminal();
  proxyServer = createProxyServer();
  startViteDev();

  // Static file fallback: Agent UI by default, Web Workspace on /workspace* & /_next*
  const staticFallback = (req, res, { pathname }) => {
    if (pathname.startsWith("/api/") || pathname.startsWith("/socket.io")) {
      jsonErr(res, 404, "Not found");
      return;
    }

    const cleanPath = pathname.replace(/^\//, "");
    // Literal dot-dot segments escape the dist roots via join(); browsers
    // normalize them away, so only a raw socket sends them — reject outright.
    if (cleanPath.split(/[\\/]/).includes("..")) { jsonErr(res, 400, "Bad request"); return; }

    // ── 1. Serve any direct static asset in WEB_DIST (icons, agents, _next, etc.) ──
    if (existsSync(WEB_DIST) && cleanPath) {
      try {
        const directWebPath = join(WEB_DIST, cleanPath);
        if (existsSync(directWebPath) && !statSync(directWebPath).isDirectory()) {
          if (serveStatic(res, directWebPath)) return;
        }
      } catch {}
    }

    // ── 2. Web Workspace routes: /workspace*, /_next*, /login* ────────
    const isWebWorkspace =
      pathname === "/workspace" ||
      pathname.startsWith("/workspace/") ||
      pathname.startsWith("/_next/") ||
      pathname === "/login" ||
      pathname.startsWith("/login/");

    if (isWebWorkspace && existsSync(WEB_DIST)) {
      // Direct file match in WEB_DIST (e.g. /_next/static/chunks/...)
      const directWebPath = join(WEB_DIST, cleanPath);
      if (serveStatic(res, directWebPath)) return;

      // Try .html extension
      if (serveStatic(res, `${directWebPath}.html`)) return;

      // Try index.html in subfolder
      if (serveStatic(res, join(directWebPath, "index.html"))) return;

      // RSC payload for a path with no prerendered .txt (dynamic terminal ids):
      // answer with the closest prerendered flight payload, never HTML — an HTML
      // answer here makes the client router hard-reload the page (kills the WS).
      const isRsc = req.headers.rsc === "1" || cleanPath.endsWith(".txt");
      if (isRsc) {
        if (cleanPath.startsWith("workspace/terminal/") && serveStatic(res, join(WEB_DIST, "workspace", "terminal", "default.txt"))) return;
        if (serveStatic(res, join(WEB_DIST, "workspace.txt"))) return;
      }

      // SPA fallback for workspace
      if (pathname.startsWith("/workspace")) {
        if (serveStatic(res, join(WEB_DIST, "workspace.html"))) return;
        if (serveStatic(res, join(WEB_DIST, "workspace", "index.html"))) return;
      }

      // SPA fallback for login
      if (pathname.startsWith("/login")) {
        if (serveStatic(res, join(WEB_DIST, "login.html"))) return;
        if (serveStatic(res, join(WEB_DIST, "login", "index.html"))) return;
      }

      jsonErr(res, 404, "Not found");
      return;
    }

    // ── 2. Agent Host UI (default for /, /ui, /assets, etc.) ───────────
    const serveAgentUi = () => {
      // Strip /ui/ prefix if present
      const uiPath = cleanPath === "ui" || cleanPath === "" ? "index.html" : cleanPath.replace(/^ui\/?/, "");
      const directUiPath = join(UI_DIST, uiPath);
      if (serveStatic(res, directUiPath)) return;
      if (serveStatic(res, join(UI_DIST, "index.html"))) return;
      jsonErr(res, 404, "Not found");
    };

    if (IS_DEV) {
      proxyToVite(req, res, serveAgentUi);
      return;
    }
    serveAgentUi();
  };

  const router = createRouter(ROUTES, { fallback: staticFallback });

  // CORS is decided inside the router, where the route's public flag is known —
  // a private route must not grant a cross-origin page the right to read it.
  const server = createServer(async (req, res) => {
    // The sites host answers before the router: the API's origin/host guards
    // exist to keep other origins out of the API, and this origin is one of
    // them — it is served statically and reaches nothing else. Anything outside
    // the site surface is refused here rather than falling through.
    if (isSitesHost(req.headers.host)) { serveSitesHost(req, res); return; }
    await router(req, res);
  });

  generateLocalToken();
  loadUiState();
  loadDesktopState();
  const refreshPermissionsSafe = () =>
    refreshPermissionsAsync().catch((err) => logger.error(`permission refresh failed: ${err?.message || err}`));
  refreshPermissionsSafe();
  // macOS TCC has no change event — poll to detect permission revoke/grant
  if (process.platform === "darwin") {
    setInterval(refreshPermissionsSafe, PERMISSION_POLL_MS);
  }

  await startTransportServer(server);

  // listen() reports bind failures (EADDRINUSE) via "error", not the callback —
  // without this they surface as uncaughtException. Exit so the CLI restarts us.
  server.on("error", (err) => {
    logger.error(`HTTP server error: ${err?.message || err}`);
    if (err?.code === "EADDRINUSE") process.exit(1);
  });

  server.listen(port, (err) => {
    if (err) throw err;
    const version = typeof __CLI_VERSION__ !== "undefined"
      ? __CLI_VERSION__
      : JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version;
    checkForUpdate(version);
    setInterval(() => checkForUpdate(version), UPDATE.checkIntervalMs);
    setConnectCheckHandler(() => checkForUpdateOnConnect(version));
  });

  // Graceful shutdown
  let isShuttingDown = false;
  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    sleepInhibitor.stop();
    logger.info(`🛑 Received ${signal}, shutting down gracefully...`);
    const forceExit = setTimeout(() => { logger.error("⚠️  Forced exit"); process.exit(1); }, 5000);
    try {
      server.close(() => logger.info("✓ HTTP server closed"));
      if (viteProcess) { try { viteProcess.kill(); } catch {} }
      const io = getIO();
      if (io) { io.emit("server:shutdown"); io.close(() => logger.info("✓ Socket.IO closed")); }
      await new Promise((r) => setTimeout(r, 500));
      clearTimeout(forceExit);
      logger.info("✅ Server stopped cleanly");
      process.exit(0);
    } catch (error) {
      logger.error(`❌ Error during shutdown: ${error?.message || error}`);
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  if (process.platform === "win32") process.on("SIGBREAK", () => gracefulShutdown("SIGBREAK"));

  return server;
}

// Boot failure must be loud + fatal — the parent CLI restarts us with backoff
startServer().catch((err) => {
  logger.error(`Server failed to start: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
