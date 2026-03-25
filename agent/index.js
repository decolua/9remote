/**
 * Server entry point - Socket.IO backend
 */

import { createServer, request as httpRequest } from "http";
import { parse } from "url";
import { exec, execSync } from "child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { setupSocketIO, getIO } from "./lib/socketio.js";
import { handleLocalSites } from "./api/localSites.js";
import { setCorsHeaders, handlePreflight } from "./middleware/cors.js";
import { createProxyServer, handleProxyRequest, startProxySession, endProxySession } from "./proxy/index.js";
import { initializeTerminal } from "./features/terminal/terminalSocket.js";
import { sendPushNotification } from "./features/terminal/pushManager.js";
import { addNotification } from "./features/terminal/notificationManager.js";
import chalk from "chalk";
import { loadKey, saveKey, writeCmd } from "./cli/utils/state.js";
import { checkPermissions, openPermissionPane } from "./cli/utils/permissions.js";
import { generateApiKeyWithMachine } from "./cli/utils/apiKey.js";
import { getConsistentMachineId } from "./cli/utils/machineId.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const IS_DEV = process.env.NODE_ENV === "development";
const VITE_PORT = 5173;

// UI dist: bundled → cli/dist/ui/, dev → server/ui/dist/
const UI_DIST = existsSync(join(__dirname, "ui", "dist"))
  ? join(__dirname, "ui", "dist")
  : join(__dirname, "ui");

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const NPM_PACKAGE_NAME = "9remote";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`;

/** Proxy request to Vite dev server (dev mode only, includes HMR websocket) */
function proxyToVite(req, res) {
  const proxy = httpRequest(
    { hostname: "localhost", port: VITE_PORT, path: req.url, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxy.on("error", () => {
    res.writeHead(502);
    res.end("Vite dev server not ready yet, please wait...");
  });
  req.pipe(proxy);
}

/** Serve a static file from ui/dist */
function serveStatic(res, filePath) {
  if (!existsSync(filePath)) return false;
  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.writeHead(200);
  res.end(readFileSync(filePath));
  return true;
}

/** Check npm registry for newer version, push via SSE if found */
async function checkForUpdate(currentVersion) {
  try {
    const res = await fetch(NPM_REGISTRY_URL);
    if (!res.ok) return;
    const { version } = await res.json();
    if (version && version !== currentVersion) {
      pushUiEvent("updateAvailable", { version });
    }
  } catch { /* non-critical */ }
}

// ── UI State (SSE) ──────────────────────────────────────────────────────────

const UI_STATE_FILE = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".9remote", "ui-state.json"
);

/** Persist uiState to disk */
function saveUiState() {
  try {
    mkdirSync(join(process.env.HOME || process.env.USERPROFILE || ".", ".9remote"), { recursive: true });
    writeFileSync(UI_STATE_FILE, JSON.stringify(uiState));
  } catch {}
}

/** Load uiState from disk */
function loadUiState() {
  try {
    if (existsSync(UI_STATE_FILE)) {
      const saved = JSON.parse(readFileSync(UI_STATE_FILE, "utf8"));
      // Only restore if tunnel was ready — otherwise start fresh
      if (saved.step === 4 && saved.permanentKey) {
        uiState = { ...uiState, ...saved };
      }
    }
  } catch {}
}

// In-memory UI state + SSE clients
let uiState = { step: 0, tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null, permanentKey: "", qrUrl: "", latency: null, uptime: null };
const sseClients = new Set();

// Active socket connections for UI display
const activeConnections = new Map();

// Remote desktop toggle state — loaded from state file on start
let desktopEnabled = false;

const DESKTOP_STATE_FILE = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".9remote", "desktop.json"
);

/** Load desktopEnabled from state file */
function loadDesktopState() {
  try {
    if (existsSync(DESKTOP_STATE_FILE)) {
      const data = JSON.parse(readFileSync(DESKTOP_STATE_FILE, "utf8"));
      desktopEnabled = !!data.enabled;
    }
  } catch {}
}

/** Save desktopEnabled to state file */
function saveDesktopState() {
  try {
    mkdirSync(join(process.env.HOME || process.env.USERPROFILE || ".", ".9remote"), { recursive: true });
    writeFileSync(DESKTOP_STATE_FILE, JSON.stringify({ enabled: desktopEnabled }));
  } catch {}
}

// Cached permissions — refreshed async, never blocks request
let cachedPermissions = { screenRecording: false, accessibility: false };

function refreshPermissionsAsync() {
  checkPermissions().then((p) => { cachedPermissions = p; });
}

function getSystemPermissions() {
  return cachedPermissions;
}

/** Open System Preferences pane for a permission, then poll until granted */
function requestSystemPermission(type) {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") { resolve(); return; }
    openPermissionPane(type);
    resolve(); // resolve immediately — UI stays open

    // Poll every 2s for up to 60s to detect when user grants permission
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      checkPermissions().then((p) => {
        cachedPermissions = p;
        if (p[type] || attempts >= 30) {
          clearInterval(poll);
          pushUiEvent("permissions", { ...cachedPermissions, desktopEnabled });
        }
      });
    }, 2000);
  });
}

/** Track a new socket connection */
export function trackConnection(socketId, ip, type = "ws") {
  activeConnections.set(socketId, { ip, type, connectedAt: Date.now() });
  pushUiEvent("connections", { connections: [...activeConnections.values()] });
}

/** Remove a socket connection */
export function untrackConnection(socketId) {
  activeConnections.delete(socketId);
  pushUiEvent("connections", { connections: [...activeConnections.values()] });
}

/** Push a log line to UI */
export function pushUiLog(message) {
  pushUiEvent("log", { message: `[${new Date().toLocaleTimeString()}] ${message}` });
}

/** Push event to all connected UI SSE clients */
function pushUiEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

/** Handle SSE connection from UI */
function handleUiEvents(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.writeHead(200);

  // Send current state + connections + permissions immediately on connect
  res.write(`data: ${JSON.stringify({ type: "state", ...uiState })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: "connections", connections: [...activeConnections.values()] })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: "permissions", ...getSystemPermissions(), desktopEnabled })}\n\n`);
  sseClients.add(res);

  req.on("close", () => sseClients.delete(res));
}

/** Handle UI state update from CLI */
function handleUiState(body) {
  try {
    const data = JSON.parse(body || "{}");
    uiState = { ...uiState, ...data };
    pushUiEvent("state", uiState);
    saveUiState();
  } catch { /* ignore malformed */ }
}

const ORANGE = chalk.rgb(230, 138, 110);

function isCodespaces() {
  return process.env.CODESPACES === "true";
}

async function handleCodespaceStop(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (!isCodespaces()) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Not running on Codespaces" }));
    return;
  }

  const codespaceName = process.env.CODESPACE_NAME;
  if (!codespaceName) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Codespace name not found" }));
    return;
  }

  // Emit event to all clients before stopping
  const io = getIO();
  if (io) {
    io.emit("codespace:stopping");
  }

  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify({ success: true, message: "Stopping codespace..." }));

  setTimeout(() => {
    exec(`gh codespace stop -c ${codespaceName}`, (error) => {
      if (error) {
        console.error("Failed to stop codespace:", error);
      }
    });
  }, 500);
}

const hostname = "localhost";
const port = parseInt(process.env.PORT || "2208", 10);

// Rate limiting for PWA push only (not badge)
const pushLastTime = {};
const PUSH_RATE_LIMIT_MS = 10000;

function handleNotify(req, res, body, query) {
  const now = Date.now();

  let type, sessionId, tool;

  if (query) {
    type = query.type || "stop";
    sessionId = query.sessionId || "";
    tool = query.tool || "claude";
  } else {
    try {
      const data = JSON.parse(body || "{}");
      type = data.type || "stop";
      sessionId = data.sessionId || "";
      tool = data.tool || "claude";
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
  }


  const io = getIO();
  if (io) {
    const notification = { type, sessionId, tool, timestamp: now };

    if (sessionId)

      // Always persist badge and notify all clients (no throttle)
      if (sessionId) {
        addNotification(sessionId, notification);
        io.emit("chatNotification", notification);

        // PWA push: throttle per tool+type to avoid spam
        const pushKey = `${tool}:${type}`;
        const pushThrottled = now - (pushLastTime[pushKey] || 0) < PUSH_RATE_LIMIT_MS;
        if (!pushThrottled) {
          pushLastTime[pushKey] = now;
          io.timeout(5000).emit("chatNotificationAck", notification, (err, responses) => {
            const connectedCount = io.sockets.sockets.size;
            const hasFocused = !err && responses && responses.length > 0;
            if (!hasFocused && connectedCount === 0) sendPushNotification(notification);
          });
        }
      }
  }

  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify({ success: true }));
}

export async function startServer() {
  // Initialize terminal sessions
  await initializeTerminal();

  const proxy = createProxyServer();

  const server = createServer(async (req, res) => {
    setCorsHeaders(res);

    if (handlePreflight(req, res)) return;

    try {
      const parsedUrl = parse(req.url, true);
      const { pathname, search } = parsedUrl;

      // UI routes: only accessible from localhost (not via tunnel)
      const isLocalhost = req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1";
      const isUiRoute = pathname === "/api/ui/events" || pathname === "/api/ui/state"
        || (!pathname.startsWith("/api/") && !pathname.startsWith("/proxy/") && !pathname.startsWith("/socket.io"));
      if (isUiRoute && !isLocalhost) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }

      // UI SSE stream
      if (pathname === "/api/ui/events") {
        handleUiEvents(req, res);
        return;
      }

      // UI state update from CLI
      if (pathname === "/api/ui/state" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          handleUiState(body);
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      // UI state snapshot
      if (pathname === "/api/ui/state" && req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        // Include permissions + desktopEnabled so UI only needs 1 fetch
        res.end(JSON.stringify({
          ...uiState,
          ...getSystemPermissions(),
          desktopEnabled,
        }));
        return;
      }

      // Stop tunnel (disconnect), keep server alive
      if (pathname === "/api/ui/stop" && req.method === "POST") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        // Immediately reset state so UI transitions to welcome screen
        uiState = { ...uiState, step: 0, tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null };
        pushUiEvent("state", uiState);
        saveUiState();
        writeCmd("stop-tunnel");
        return;
      }

      // Start tunnel (reconnect)
      if (pathname === "/api/ui/start" && req.method === "POST") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        // Immediately push step:1 so UI transitions to progress screen
        uiState = { ...uiState, step: 1 };
        pushUiEvent("state", uiState);
        saveUiState();
        writeCmd("start-tunnel");
        return;
      }

      // Generate new one-time key
      if (pathname === "/api/key/one-time" && req.method === "POST") {
        const workerUrl = uiState.workerUrl || "https://9remote.cc";
        const permanentKey = uiState.permanentKey;
        if (!permanentKey) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "No permanent key set" }));
          return;
        }
        try {
          const r = await fetch(`${workerUrl}/api/temp-key/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: permanentKey, expiryMinutes: 30 }),
          });
          const data = await r.json();
          const qrUrl = `${workerUrl}/login?k=${data.tempKey}`;
          uiState = { ...uiState, oneTimeKey: data.tempKey, oneTimeKeyExpiresAt: data.expiresAt, qrUrl };
          pushUiEvent("state", uiState);
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(JSON.stringify({ oneTimeKey: data.tempKey, expiresAt: data.expiresAt, qrUrl }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Regenerate permanent key
      if (pathname === "/api/key/regenerate" && req.method === "POST") {
        res.setHeader("Content-Type", "application/json");
        try {
          const machineId = await getConsistentMachineId();
          const { key } = generateApiKeyWithMachine(machineId);
          const existing = loadKey();
          saveKey(machineId, key, existing?.name || "Default");
          pushUiEvent("state", { ...uiState, permanentKey: key });
          uiState = { ...uiState, permanentKey: key };
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, permanentKey: key }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Get system permissions status
      if (pathname === "/api/permissions" && req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(getSystemPermissions()));
        return;
      }

      // Request a system permission
      if (pathname === "/api/permissions/request" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", async () => {
          try {
            const { type } = JSON.parse(body || "{}");
            await requestSystemPermission(type);
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // Toggle remote desktop
      if (pathname === "/api/desktop/toggle" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", () => {
          try {
            const { enabled } = JSON.parse(body || "{}");
            desktopEnabled = !!enabled;
            saveDesktopState();
            // Push updated state including desktopEnabled + fresh permissions
            pushUiEvent("permissions", { ...getSystemPermissions(), desktopEnabled });
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, enabled: desktopEnabled }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // Get active connections
      if (pathname === "/api/connections" && req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ connections: [...activeConnections.values()] }));
        return;
      }

      // Health check endpoint
      if (pathname === "/api/health") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
        return;
      }

      // Version endpoint
      if (pathname === "/api/version") {
        const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ version: pkg.version }));
        return;
      }

      // Serve UI: proxy to Vite (dev) or serve static (production)
      if (!pathname.startsWith("/api/") && !pathname.startsWith("/proxy/") && !pathname.startsWith("/socket.io")) {
        if (IS_DEV) {
          proxyToVite(req, res);
          return;
        }
        const filePath = pathname === "/" || pathname === ""
          ? join(UI_DIST, "index.html")
          : join(UI_DIST, pathname);
        if (serveStatic(res, filePath)) return;
        // SPA fallback
        if (serveStatic(res, join(UI_DIST, "index.html"))) return;
      }

      // API routes
      if (pathname === "/api/local-sites") {
        await handleLocalSites(req, res);
        return;
      }

      // Codespace stop endpoint
      if (pathname === "/api/codespace/stop") {
        await handleCodespaceStop(req, res);
        return;
      }

      // Notification endpoint (called by AI tool hooks)
      if (pathname === "/api/notify" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          handleNotify(req, res, body);
        });
        return;
      }

      if (pathname === "/api/notify" && req.method === "GET") {
        handleNotify(req, res, null, parsedUrl.query);
        return;
      }

      // Proxy session management
      if (pathname === "/api/proxy/start" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          const { port } = JSON.parse(body || "{}");
          if (port) {
            startProxySession(port);
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Port required" }));
          }
        });
        return;
      }

      if (pathname === "/api/proxy/end" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          const { port } = JSON.parse(body || "{}");
          if (port) {
            endProxySession(port);
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Port required" }));
          }
        });
        return;
      }

      // Proxy routes
      if (pathname.startsWith("/proxy/")) {
        const match = pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
        if (match) {
          handleProxyRequest(proxy, req, res, match[1], match[2] || "/", search);
          return;
        }
      }

      // 404 for unknown routes
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      console.error("Error:", req.url, err);
      res.statusCode = 500;
      res.end("Internal server error");
    }
  });

  // Load persisted states + warm up permission cache
  loadUiState();
  loadDesktopState();
  refreshPermissionsAsync();

  await setupSocketIO(server);

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(ORANGE(`✅ Server ready on http://${hostname}:${port}`));

    // Check for updates in background (non-blocking)
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    checkForUpdate(pkg.version);
  });

  // Graceful shutdown handler
  let isShuttingDown = false;
  
  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log(chalk.yellow(`\n🛑 Received ${signal}, shutting down gracefully...`));
    
    // Set timeout to force exit if cleanup takes too long
    const forceExitTimeout = setTimeout(() => {
      console.log(chalk.red("⚠️  Forced exit after 5s timeout"));
      process.exit(1);
    }, 5000);
    
    try {
      // 1. Stop accepting new connections
      server.close(() => {
        console.log(chalk.gray("✓ HTTP server closed"));
      });
      
      // 2. Close all Socket.IO connections
      const io = getIO();
      if (io) {
        io.emit("server:shutdown");
        io.close(() => {
          console.log(chalk.gray("✓ Socket.IO closed"));
        });
      }
      
      // 3. Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
      
      clearTimeout(forceExitTimeout);
      console.log(chalk.green("✅ Server stopped cleanly"));
      process.exit(0);
    } catch (error) {
      console.error(chalk.red("❌ Error during shutdown:"), error);
      clearTimeout(forceExitTimeout);
      process.exit(1);
    }
  };
  
  // Register signal handlers
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  
  // Windows-specific signal
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => gracefulShutdown("SIGBREAK"));
  }
  
  return server;
}

// Auto start if run directly
startServer();
