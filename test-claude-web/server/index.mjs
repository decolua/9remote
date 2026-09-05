// test-claude-web/server/index.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import { ClaudeProcessManager } from "./claudeProcess.mjs";

const PORT = 3333;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const require = createRequire(import.meta.url);
const wsPath = require.resolve("ws", { paths: [path.resolve(rootDir, ".."), path.resolve(rootDir, "../agent")] });
const ptyPath = require.resolve("node-pty", { paths: [path.resolve(rootDir, "../agent")] });
const { WebSocketServer } = require(wsPath);
const pty = require(ptyPath);

// 1. Build Client Bundle
console.log("⚡ Đang biên dịch client bundle (React + xterm.js)...");
await esbuild.build({
  entryPoints: [path.join(rootDir, "src/main.jsx")],
  bundle: true,
  outfile: path.join(rootDir, "public/dist/bundle.js"),
  format: "iife",
  loader: { ".js": "jsx", ".jsx": "jsx" },
  define: { "process.env.NODE_ENV": '"development"' },
  nodePaths: [
    path.resolve(rootDir, "../web/node_modules"),
    path.resolve(rootDir, "../agent/node_modules"),
    path.resolve(rootDir, "../node_modules"),
  ],
});
console.log("✓ Biên dịch hoàn tất!");

// 2. Start Claude Process Manager
const claudeManager = new ClaudeProcessManager();
claudeManager.start();

const sseClients = new Set();

function broadcastSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      if (!client.writableEnded) client.write(payload);
    } catch {}
  }
}

// Forward all process events to connected SSE clients
claudeManager.subscribe((event, data) => {
  broadcastSse(event, data);
});

// 3. HTTP Server
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // A. Static Files
  if ((req.method === "GET" || req.method === "HEAD") && (req.url === "/" || req.url === "/index.html")) {
    const html = fs.readFileSync(path.join(rootDir, "public/index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && req.url === "/dist/bundle.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const js = fs.readFileSync(path.join(rootDir, "public/dist/bundle.js"), "utf8");
    res.end(js);
    return;
  }

  // B. Persistent SSE stream for real-time Dual-View (Chat + xterm)
  if (req.method === "GET" && req.url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    sseClients.add(res);

    // Send existing ANSI history to catch up newly opened tab
    for (const chunk of claudeManager.ansiHistory) {
      res.write(`event: ansi\ndata: ${JSON.stringify({ chunk })}\n\n`);
    }

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // C. API Endpoints
  const readBody = (callback) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const json = body ? JSON.parse(body) : {};
        callback(json);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON: " + err.message }));
      }
    });
  };

  if (req.method === "POST" && req.url === "/api/chat") {
    readBody(({ message }) => {
      try {
        claudeManager.sendPrompt(message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/permission") {
    readBody(({ requestId, behavior }) => {
      try {
        claudeManager.resolvePermission(requestId, behavior);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/answer_question") {
    readBody(({ requestId, answers }) => {
      try {
        claudeManager.resolveQuestion(requestId, answers);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/mode") {
    readBody(({ mode }) => {
      claudeManager.start(mode);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/reset") {
    claudeManager.start();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/stop") {
    claudeManager.stop();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n======================================================`);
  console.log(`✨ Modular Claude Code Web Harness (Dual-View React):`);
  console.log(`   👉 http://localhost:${PORT}`);
  console.log(`   ⌨️ Phím tắt: Ctrl + ~ chuyển tức thì giữa UI & Terminal`);
  console.log(`======================================================\n`);
});

// 4. Native PTY Terminal WebSocket (matching 9remote)
const wss = new WebSocketServer({ server, path: "/ws/terminal" });

wss.on("connection", (ws) => {
  const shell = process.env.SHELL || "/bin/zsh";
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 28,
    cwd: process.cwd(),
    env: process.env,
  });

  ptyProcess.onData((data) => {
    try {
      ws.send(data);
    } catch {}
  });

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        ptyProcess.resize(parsed.cols, parsed.rows);
      } else if (parsed.type === "input") {
        ptyProcess.write(parsed.data);
      }
    } catch {
      ptyProcess.write(msg.toString());
    }
  });

  ws.on("close", () => {
    try {
      ptyProcess.kill();
    } catch {}
  });
});
