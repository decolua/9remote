/**
 * Standalone server wrapper - wraps Next.js standalone with custom server features
 */

import { createServer } from "http";
import { parse } from "url";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";

// Socket.IO and features
import { Server as SocketServer } from "socket.io";
import { setupTerminalSocket } from "../features/terminal/services/terminalSocket.js";
import { setupRemoteSocket, checkRemoteAvailable } from "../features/remote/services/remoteSocket.js";
import { setupFileExplorerSocket } from "../features/fileExplorer/services/fileExplorerSocket.js";

// Proxy
import { createProxyServer, handleProxyRequest, startProxySession, endProxySession } from "./proxy/index.js";
import { handleLocalSites } from "./api/localSites.js";
import { setCorsHeaders, handlePreflight } from "./middleware/cors.js";

// __dirname will be dist/ when bundled, src/server/ when running from source
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "2208", 10);

// Resolve standalone path relative to the bundled file location
function getStandalonePath() {
  // When bundled: dist/server.cjs -> dist/standalone
  // When source: src/server/standalone.js -> dist/standalone
  const bundledPath = path.resolve(__dirname, "standalone");
  const sourcePath = path.resolve(__dirname, "../../dist/standalone");
  
  const fs = require("fs");
  if (fs.existsSync(bundledPath)) return bundledPath;
  if (fs.existsSync(sourcePath)) return sourcePath;
  
  throw new Error(`Standalone not found at ${bundledPath} or ${sourcePath}`);
}

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

  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify({ success: true, message: "Stopping codespace..." }));

  setTimeout(() => {
    exec(`gh codespace stop -c ${codespaceName}`, (error) => {
      if (error) console.error("Failed to stop codespace:", error);
    });
  }, 500);
}

function setupSocketIO(server) {
  const io = new SocketServer(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true,
      allowedHeaders: ["*"]
    },
    transports: ["websocket", "polling"],
    allowEIO3: true,
    allowUpgrades: true,
    pingTimeout: 60000,
    pingInterval: 25000
  });

  checkRemoteAvailable();
  setupTerminalSocket(io);
  setupRemoteSocket(io);
  setupFileExplorerSocket(io);

  return io;
}

async function startServer() {
  // Dynamic import Next.js standalone handler
  const standalonePath = getStandalonePath();
  
  // Set up Next.js environment
  process.env.NODE_ENV = "production";
  process.chdir(standalonePath);
  
  // Import Next.js from standalone
  const next = await import("next");
  const nextApp = next.default({ 
    dev: false, 
    dir: standalonePath,
    conf: {
      distDir: ".next"
    }
  });
  
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();
  
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
      
      // Next.js handler
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error:", req.url, err);
      res.statusCode = 500;
      res.end("Internal server error");
    }
  });

  setupSocketIO(server);

  server.listen(PORT, () => {
    console.log(`✅ Ready on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
