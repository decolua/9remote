/**
 * Server entry point - Socket.IO backend
 */

import { createServer } from "http";
import { parse } from "url";
import { exec } from "child_process";
import { setupSocketIO, getIO } from "./lib/socketio.js";
import { handleLocalSites } from "./api/localSites.js";
import { setCorsHeaders, handlePreflight } from "./middleware/cors.js";
import { createProxyServer, handleProxyRequest, startProxySession, endProxySession } from "./proxy/index.js";
import { initializeTerminal } from "./features/terminal/terminalSocket.js";
import { sendPushNotification } from "./features/terminal/pushManager.js";
import { addNotification } from "./features/terminal/notificationManager.js";
import chalk from "chalk";

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

      // Health check endpoint
      if (pathname === "/api/health") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
        return;
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

  await setupSocketIO(server);

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(ORANGE(`✅ Server ready on http://${hostname}:${port}`));
  });
}

// Auto start if run directly
startServer();
