/**
 * Server entry point - Socket.IO backend
 */

import { createServer, request as httpRequest } from "http";
import { parse } from "url";
import { exec, execSync } from "child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { setupSocketIO, getIO, approveSocketDevice, rejectSocketDevice } from "./lib/socketio.js";
import { STEP, browserFetch } from "./lib/constants.js";
import { getAllPendingApprovals, getApprovedDevices, removeDevice } from "./lib/deviceApproval.js";
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

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) return false;
  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || "application/octet-stream";
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
    if (version && version !== currentVersion) {
      pushUiEvent("updateAvailable", { version });
    }
  } catch { /* non-critical */ }
}

const UI_STATE_FILE = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".9remote", "ui-state.json"
);

function saveUiState() {
  try {
    mkdirSync(join(process.env.HOME || process.env.USERPROFILE || ".", ".9remote"), { recursive: true });
    writeFileSync(UI_STATE_FILE, JSON.stringify(uiState));
  } catch { }
}

function loadUiState() {
  try {
    if (existsSync(UI_STATE_FILE)) {
      const saved = JSON.parse(readFileSync(UI_STATE_FILE, "utf8"));
      // Only restore if tunnel was ready — otherwise start fresh
      if (saved.step === STEP.READY && saved.permanentKey) {
        uiState = { ...uiState, ...saved };
      }
    }
  } catch { }
}

let uiState = { step: STEP.STOPPED, tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null, permanentKey: "", qrUrl: "", latency: null, uptime: null };
const sseClients = new Set();

const activeConnections = new Map();

let desktopEnabled = false;

const DESKTOP_STATE_FILE = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".9remote", "desktop.json"
);

function loadDesktopState() {
  try {
    if (existsSync(DESKTOP_STATE_FILE)) {
      const data = JSON.parse(readFileSync(DESKTOP_STATE_FILE, "utf8"));
      desktopEnabled = !!data.enabled;
    }
  } catch { }
}

function saveDesktopState() {
  try {
    mkdirSync(join(process.env.HOME || process.env.USERPROFILE || ".", ".9remote"), { recursive: true });
    writeFileSync(DESKTOP_STATE_FILE, JSON.stringify({ enabled: desktopEnabled }));
  } catch { }
}

let cachedPermissions = { screenRecording: false, accessibility: false };

function refreshPermissionsAsync() {
  checkPermissions().then((p) => { cachedPermissions = p; });
}

function getSystemPermissions() {
  return cachedPermissions;
}

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

export function clearOneTimeKey() {
  uiState = { ...uiState, oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "" };
  pushUiEvent("state", uiState);
  saveUiState();
}

export function trackConnection(socketId, ip, type = "ws") {
  activeConnections.set(socketId, { ip, type, connectedAt: Date.now() });
  pushUiEvent("connections", { connections: [...activeConnections.values()] });
}

export function untrackConnection(socketId) {
  activeConnections.delete(socketId);
  pushUiEvent("connections", { connections: [...activeConnections.values()] });
}

export function pushUiLog(message) {
  pushUiEvent("log", { message: `[${new Date().toLocaleTimeString()}] ${message}` });
}

export function pushUiEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

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

function handleUiState(body) {
  try {
    const data = JSON.parse(body || "{}");
    uiState = { ...uiState, ...data };
    pushUiEvent("state", uiState);
    saveUiState();
  } catch { /* ignore malformed */ }
}

const ORANGE = chalk.rgb(230, 138, 110);

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve(body));
  });
}

function jsonOk(res, data = { ok: true }) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify(data));
}

function jsonErr(res, code, msg) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(code);
  res.end(JSON.stringify({ error: msg }));
}

function isCodespaces() {
  return process.env.CODESPACES === "true";
}

async function handleCodespaceStop(req, res) {
  if (req.method !== "POST") { jsonErr(res, 405, "Method not allowed"); return; }
  if (!isCodespaces()) { jsonErr(res, 400, "Not running on Codespaces"); return; }
  const codespaceName = process.env.CODESPACE_NAME;
  if (!codespaceName) { jsonErr(res, 400, "Codespace name not found"); return; }

  const io = getIO();
  if (io) io.emit("codespace:stopping");
  jsonOk(res, { success: true, message: "Stopping codespace..." });

  setTimeout(() => {
    exec(`gh codespace stop -c ${codespaceName}`, { windowsHide: true }, (error) => {
      if (error) {
        console.error("Failed to stop codespace:", error);
      }
    });
  }, 500);
}

const hostname = "localhost";
const port = parseInt(process.env.PORT || "2208", 10);

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
      jsonErr(res, 400, "Invalid JSON"); return;
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

  jsonOk(res, { success: true });
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

      const isLocalhost = req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1";
      const isUiRoute = pathname === "/api/ui/events" || pathname === "/api/ui/state"
        || (!pathname.startsWith("/api/") && !pathname.startsWith("/proxy/") && !pathname.startsWith("/socket.io"));
      if (isUiRoute && !isLocalhost) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }

      if (pathname === "/api/ui/events") {
        handleUiEvents(req, res);
        return;
      }

      if (pathname === "/api/ui/state" && req.method === "POST") {
        handleUiState(await readBody(req));
        jsonOk(res);
        return;
      }

      if (pathname === "/api/ui/state" && req.method === "GET") {
        jsonOk(res, { ...uiState, ...getSystemPermissions(), desktopEnabled });
        return;
      }

      if (pathname === "/api/ui/stop" && req.method === "POST") {
        jsonOk(res);
        uiState = { ...uiState, step: STEP.STOPPED, tunnelUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null };
        pushUiEvent("state", uiState);
        saveUiState();
        writeCmd("stop-tunnel");
        return;
      }

      if (pathname === "/api/ui/start" && req.method === "POST") {
        jsonOk(res);
        uiState = { ...uiState, step: STEP.PREPARING };
        pushUiEvent("state", uiState);
        saveUiState();
        writeCmd("start-tunnel");
        return;
      }

      if (pathname === "/api/key/one-time" && req.method === "POST") {
        const workerUrl = uiState.workerUrl || "https://9remote.cc";
        if (!uiState.permanentKey) { jsonErr(res, 400, "No permanent key set"); return; }
        try {
          const r = await browserFetch(`${workerUrl}/api/temp-key/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: uiState.permanentKey, expiryMinutes: 30 }),
          });
          const data = await r.json();
          const qrUrl = `${workerUrl}/login?k=${data.tempKey}`;
          uiState = { ...uiState, oneTimeKey: data.tempKey, oneTimeKeyExpiresAt: data.expiresAt, qrUrl };
          pushUiEvent("state", uiState);
          jsonOk(res, { oneTimeKey: data.tempKey, expiresAt: data.expiresAt, qrUrl });
        } catch (err) { jsonErr(res, 500, err.message); }
        return;
      }

      if (pathname === "/api/key/regenerate" && req.method === "POST") {
        try {
          const machineId = await getConsistentMachineId();
          const { key } = generateApiKeyWithMachine(machineId);
          const existing = loadKey();
          saveKey(machineId, key, existing?.name || "Default");
          uiState = { ...uiState, permanentKey: key };
          pushUiEvent("state", uiState);
          jsonOk(res, { ok: true, permanentKey: key });
        } catch (err) { jsonErr(res, 500, err.message); }
        return;
      }

      if (pathname === "/api/permissions" && req.method === "GET") {
        jsonOk(res, getSystemPermissions());
        return;
      }

      if (pathname === "/api/permissions/request" && req.method === "POST") {
        try {
          const { type } = JSON.parse(await readBody(req) || "{}");
          await requestSystemPermission(type);
          jsonOk(res);
        } catch (err) { jsonErr(res, 500, err.message); }
        return;
      }

      if (pathname === "/api/desktop/toggle" && req.method === "POST") {
        try {
          const { enabled } = JSON.parse(await readBody(req) || "{}");
          desktopEnabled = !!enabled;
          saveDesktopState();
          pushUiEvent("permissions", { ...getSystemPermissions(), desktopEnabled });
          jsonOk(res, { ok: true, enabled: desktopEnabled });
        } catch (err) { jsonErr(res, 500, err.message); }
        return;
      }

      if ((pathname === "/api/device/approve" || pathname === "/api/device/reject") && req.method === "POST") {
        try {
          const { socketId } = JSON.parse(await readBody(req) || "{}");
          const handler = pathname.endsWith("approve") ? approveSocketDevice : rejectSocketDevice;
          const ok = handler(socketId);
          res.setHeader("Content-Type", "application/json");
          res.writeHead(ok ? 200 : 404);
          res.end(JSON.stringify({ ok }));
        } catch (err) { jsonErr(res, 500, err.message); }
        return;
      }

      if (pathname === "/api/device/pending" && req.method === "GET") {
        jsonOk(res, { pending: getAllPendingApprovals() });
        return;
      }

      if (pathname === "/api/device/approved" && req.method === "GET") {
        jsonOk(res, { devices: getApprovedDevices() });
        return;
      }

      if (pathname === "/api/device/remove" && req.method === "POST") {
        try {
          const { deviceId } = JSON.parse(await readBody(req) || "{}");
          removeDevice(deviceId);
          jsonOk(res);
        } catch (err) { jsonErr(res, 500, err.message); }
        return;
      }

      if (pathname === "/api/connections" && req.method === "GET") {
        jsonOk(res, { connections: [...activeConnections.values()] });
        return;
      }

      if (pathname === "/api/health") {
        jsonOk(res, { status: "ok", timestamp: Date.now() });
        return;
      }

      if (pathname === "/api/version") {
        const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
        jsonOk(res, { version: pkg.version });
        return;
      }

      if (!pathname.startsWith("/api/") && !pathname.startsWith("/proxy/") && !pathname.startsWith("/socket.io")) {
        if (IS_DEV) {
          proxyToVite(req, res);
          return;
        }
        const filePath = pathname === "/" || pathname === ""
          ? join(UI_DIST, "index.html")
          : join(UI_DIST, pathname);
        if (serveStatic(res, filePath)) return;
        if (serveStatic(res, join(UI_DIST, "index.html"))) return;
      }

      if (pathname === "/api/local-sites") {
        await handleLocalSites(req, res);
        return;
      }

      if (pathname === "/api/codespace/stop") {
        await handleCodespaceStop(req, res);
        return;
      }

      if (pathname === "/api/notify" && req.method === "POST") {
        handleNotify(req, res, await readBody(req));
        return;
      }

      if (pathname === "/api/notify" && req.method === "GET") {
        handleNotify(req, res, null, parsedUrl.query);
        return;
      }

      if ((pathname === "/api/proxy/start" || pathname === "/api/proxy/end") && req.method === "POST") {
        const { port: p } = JSON.parse(await readBody(req) || "{}");
        if (!p) { jsonErr(res, 400, "Port required"); return; }
        pathname.endsWith("start") ? startProxySession(p) : endProxySession(p);
        jsonOk(res, { success: true });
        return;
      }

      if (pathname.startsWith("/proxy/")) {
        const match = pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
        if (match) {
          handleProxyRequest(proxy, req, res, match[1], match[2] || "/", search);
          return;
        }
      }

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
    // Server started silently

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

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  if (process.platform === "win32") {
    process.on("SIGBREAK", () => gracefulShutdown("SIGBREAK"));
  }

  return server;
}

startServer();
