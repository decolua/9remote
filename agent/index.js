/**
 * Server entry point - config-driven HTTP router + Socket.IO
 */

import { createServer, request as httpRequest } from "http";
import { execFile, execSync, spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";

import { createRouter, jsonOk, jsonErr } from "./lib/router.js";
import { STEP, browserFetch, PERMISSION_POLL_MS, NPM_REGISTRY_URL, hideDockIcon } from "./lib/constants.js";
import { initLogger, createLogger } from "./lib/logger.js";

hideDockIcon();
initLogger();
const logger = createLogger("server");
import { startTransportServer, getIO } from "./transport/server.js";
import { setCorsHeaders, handlePreflight } from "./middleware/cors.js";
import { createProxyServer, handleProxyRequest, startProxySession, endProxySession } from "./proxy/index.js";
import { handlePreviewRequest } from "./features/fileExplorer/previewServer.js";
import { initializeTerminal } from "./features/terminal/terminalSocket.js";
import { handleLocalSites } from "./api/localSites.js";
import { verifyApiKeyCrc } from "./cli/utils/apiKey.js";
import { generateLocalToken } from "./lib/localToken.js";
import { isNewerVersion } from "./cli/utils/updateChecker.js";

import {
  loadUiState, loadDesktopState, refreshPermissionsAsync, pushUiEvent, setRemoteAvailable,
  handleSseEvents, handleStateGet, handleStatePost,
  handleStop, handleStart, handleStopTunnel, handleShutdown,
  handleConnections, handleDesktopToggle, handleRtcToggle, handleLogsGet, handleLogsClear,
  handlePermissionsGet, handlePermissionsRequest,
  handleAutoStartGet, handleAutoStartPost,
  handleLocalToken, handleUpdate, setUpdateInfo,
} from "./api/ui.js";
import { broadcastServerInfo, setConnectCheckHandler } from "./features/terminal/terminalSocket.js";
import { UPDATE } from "./cli/config.js";
import { handleOneTimeKey, handleRegenerate } from "./api/key.js";
import { handleApprove, handleReject, handlePending, handleApproved, handleRemove, handleDisconnect, handleRejected, handleApproveRejected, handleClearRejected, handleGetAutoApprove, handleSetAutoApprove, handleSetLabel } from "./api/device.js";
import { handleNotifyPost, handleNotifyGet } from "./api/notify.js";
import { handleSleepInhibitGet, handleSleepInhibitPost } from "./api/sleepInhibit.js";
import { handleDesktopUnlockGet, handleDesktopUnlockInstall, handleDesktopUnlockType, handleDesktopUnlockUninstall } from "./api/desktopUnlock.js";
import { handleSessionsList, handleSessionDelete } from "./api/sessions.js";
import { handleSystemStats } from "./api/system.js";
import * as sleepInhibitor from "./lib/sleepInhibitor.js";
import { loadSettings } from "./cli/utils/state.js";
import { REMOTE_CONFIG } from "./features/remote/REMOTE_CONFIG.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const IS_DEV = process.env.NODE_ENV === "development";
const VITE_PORT = 5173;

const UI_DIST = existsSync(join(__dirname, "ui", "dist"))
  ? join(__dirname, "ui", "dist")
  : join(__dirname, "ui");

const MIME_TYPES = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff",
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

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) return false;
  const mime = MIME_TYPES[extname(filePath)] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.writeHead(200);
  res.end(readFileSync(filePath));
  return true;
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

// ── Proxy handlers ────────────────────────────────────────────

let proxyServer;

async function handleProxyStartEnd(req, res, { pathname }) {
  // Verify API key (required for tunnel access)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ") || !verifyApiKeyCrc(authHeader.slice(7))) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  const { parseJsonBody } = await import("./lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  if (!data.port) { jsonErr(res, 400, "Port required"); return; }
  pathname.endsWith("start") ? startProxySession(data.port) : endProxySession(data.port);
  jsonOk(res, { success: true });
}

function handleProxy(req, res, { pathname, search }) {
  const match = pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
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
    jsonOk(res, { version });
  }},
  { path: "/api/notify",           method: "POST", public: true, handler: handleNotifyPost },
  { path: "/api/notify",           method: "GET",  public: true, handler: handleNotifyGet },
  { path: "/proxy/*",              method: "*",    public: true, handler: handleProxy },
  { path: "/preview/*",            method: "GET",  public: true, handler: handlePreview },

  // UI state & SSE (localhost-only)
  { path: "/api/ui/events",        method: "GET",  handler: handleSseEvents },
  { path: "/api/local-token",      method: "GET",  handler: handleLocalToken },
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
  { path: "/api/desktop-unlock",   method: "GET",  handler: handleDesktopUnlockGet },
  { path: "/api/desktop-unlock/install", method: "POST", handler: handleDesktopUnlockInstall },
  { path: "/api/desktop-unlock/uninstall", method: "POST", handler: handleDesktopUnlockUninstall },
  { path: "/api/desktop-unlock/type",    method: "POST", handler: handleDesktopUnlockType },
  { path: "/api/sessions",         method: "GET",  handler: handleSessionsList },
  { path: "/api/sessions/delete",  method: "POST", handler: handleSessionDelete },
  { path: "/api/local-sites",      method: "*",    public: true, handler: handleLocalSites },
  { path: "/api/codespace/stop",   method: "POST", handler: handleCodespaceStop },

  // Proxy session management (tunnel-accessible, requires API key)
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
    if (settings.sleepInhibit === false) mode = "never"; // legacy off → treat as default
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

  // Static file / Vite dev fallback (localhost-only)
  const staticFallback = (req, res, { pathname }) => {
    if (pathname.startsWith("/api/") || pathname.startsWith("/socket.io")) {
      jsonErr(res, 404, "Not found");
      return;
    }
    const isTunnel = !!req.headers["cf-connecting-ip"];
    const isLocal = req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1";
    if (isTunnel || !isLocal) { jsonErr(res, 403, "Forbidden"); return; }
    const serveStaticFiles = () => {
      const filePath = (pathname === "/" || pathname === "") ? join(UI_DIST, "index.html") : join(UI_DIST, pathname);
      if (serveStatic(res, filePath)) return;
      serveStatic(res, join(UI_DIST, "index.html"));
    };
    if (IS_DEV) { proxyToVite(req, res, serveStaticFiles); return; }
    serveStaticFiles();
  };

  const router = createRouter(ROUTES, { fallback: staticFallback });

  const server = createServer(async (req, res) => {
    setCorsHeaders(res);
    if (handlePreflight(req, res)) return;
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
