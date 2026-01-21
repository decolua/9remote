/**
 * Server initialization and request routing
 */

import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { exec } from "child_process";
import { setupSocketIO } from "../shared/lib/socketio.js";
import { createProxyServer, handleProxyRequest, startProxySession, endProxySession } from "./proxy/index.js";
import { handleLocalSites } from "./api/localSites.js";
import { setCorsHeaders, handlePreflight } from "./middleware/cors.js";

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

  // Execute stop command after response
  setTimeout(() => {
    exec(`gh codespace stop -c ${codespaceName}`, (error) => {
      if (error) {
        console.error("Failed to stop codespace:", error);
      }
    });
  }, 500);
}

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

export async function startServer() {
  await app.prepare();
  
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

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://${hostname}:${port}`);
  });
}
