/**
 * Server entry point - Socket.IO backend
 */

import { createServer } from "http";
import { parse } from "url";
import { exec } from "child_process";
import { setupSocketIO } from "./lib/socketio.js";
import { handleLocalSites } from "./api/localSites.js";
import { setCorsHeaders, handlePreflight } from "./middleware/cors.js";
import { createProxyServer, handleProxyRequest, startProxySession, endProxySession } from "./proxy/index.js";

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
      if (error) {
        console.error("Failed to stop codespace:", error);
      }
    });
  }, 500);
}

const hostname = "localhost";
const port = parseInt(process.env.PORT || "2208", 10);

export async function startServer() {
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
    console.log(`✅ Server ready on http://${hostname}:${port}`);
  });
}

// Auto start if run directly
startServer();
