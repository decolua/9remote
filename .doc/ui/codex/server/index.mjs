// test-codex-web/server/index.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { exec, execSync } from "node:child_process";
import esbuild from "esbuild";
import { CodexProcessManager } from "./codexProcess.mjs";
import { searchFiles } from "./files.mjs";
import { listCodexSessions } from "./sessions.mjs";
import { listCodexSkills } from "./skills.mjs";
import { listCodexMcpServers } from "./mcp.mjs";

const PORT = 3334;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const projectRoot = path.resolve(rootDir, "../../..");

const require = createRequire(import.meta.url);
const wsPath = require.resolve("ws", { paths: [projectRoot, path.resolve(projectRoot, "agent")] });
const ptyPath = require.resolve("node-pty", { paths: [path.resolve(projectRoot, "agent")] });
const { WebSocketServer } = require(wsPath);
const pty = require(ptyPath);

function getGitBranch(cwd) {
  try {
    return execSync("git branch --show-current", { cwd, encoding: "utf8" }).trim();
  } catch {
    return "main";
  }
}

// 1. Build Client Bundle
console.log("⚡ Đang biên dịch bundle client cho Codex Web Harness...");
await esbuild.build({
  entryPoints: [path.join(rootDir, "src/main.jsx")],
  bundle: true,
  outfile: path.join(rootDir, "public/dist/bundle.js"),
  format: "iife",
  loader: { ".js": "jsx", ".jsx": "jsx" },
  define: { "process.env.NODE_ENV": '"development"' },
  nodePaths: [
    path.resolve(projectRoot, "web/node_modules"),
    path.resolve(projectRoot, "agent/node_modules"),
    path.resolve(projectRoot, "node_modules"),
  ],
});
console.log("✓ Biên dịch hoàn tất!");

// 2. Start Codex Process Manager
const codexManager = new CodexProcessManager();

const sseClients = new Set();

function broadcastSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      if (!client.writableEnded) client.write(payload);
    } catch {}
  }
}

codexManager.subscribe((event, data) => {
  broadcastSse(event, data);
});

// 3. HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // A. Static Files
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/" || pathname === "/index.html")) {
    const html = fs.readFileSync(path.join(rootDir, "public/index.html"), "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.writeHead(200);
    res.end(html);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/dist/bundle.js") {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.writeHead(200);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const js = fs.readFileSync(path.join(rootDir, "public/dist/bundle.js"), "utf8");
    res.end(js);
    return;
  }

  // B. Persistent SSE stream
  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    sseClients.add(res);

    // Initial state
    const skills = listCodexSkills();
    const mcpServers = listCodexMcpServers();
    codexManager.metadata.skills = skills;
    codexManager.metadata.mcpServers = mcpServers;

    res.write(`event: init\ndata: ${JSON.stringify(codexManager.metadata)}\n\n`);
    res.write(`event: git_branch\ndata: ${JSON.stringify({ branch: getGitBranch(projectRoot) })}\n\n`);

    for (const chunk of codexManager.ansiHistory) {
      res.write(`event: ansi\ndata: ${JSON.stringify({ chunk })}\n\n`);
    }

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  const readBody = () =>
    new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });

  // C. API Endpoints
  if (req.method === "GET" && pathname === "/api/files") {
    const q = parsedUrl.searchParams.get("q") || "";
    const files = searchFiles(projectRoot, q, 25);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    const sessions = await listCodexSessions(25);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      branch: getGitBranch(projectRoot),
      metadata: codexManager.metadata,
      stats: codexManager.stats,
      isTurnRunning: codexManager.isTurnRunning,
    }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/skills") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ skills: listCodexSkills() }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/mcp") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ servers: listCodexMcpServers() }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/doctor") {
    let codexVer = "";
    try {
      codexVer = execSync("codex --version", { encoding: "utf8" }).trim();
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      projectRoot,
      branch: getGitBranch(projectRoot),
      codexVersion: codexVer,
      threadId: codexManager.activeThreadId,
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    try {
      const { message } = await readBody();
      codexManager.sendPrompt(message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/shell") {
    try {
      const { command } = await readBody();
      if (!command) throw new Error("Missing command");
      codexManager.emitAnsi(`\r\n\x1b[33m[! SHELL]\x1b[0m \x1b[1;37m${command}\x1b[0m\r\n`);

      exec(command, { cwd: projectRoot, timeout: 30000 }, (error, stdout, stderr) => {
        const out = stdout || "";
        const err = stderr || (error ? error.message : "");
        if (out) codexManager.emitAnsi(out.replace(/\n/g, "\r\n") + "\r\n");
        if (err) codexManager.emitAnsi(`\x1b[31m${err.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          stdout: out,
          stderr: err,
          exitCode: error ? error.code || 1 : 0,
        }));
      });
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/resume") {
    try {
      const { sessionId } = await readBody();
      codexManager.resumeSession(sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessionId }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/options") {
    try {
      const { model, effort, sandbox } = await readBody();
      codexManager.setOptions({ model, effort, sandbox });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/reset") {
    codexManager.reset();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/stop") {
    codexManager.stop();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n======================================================`);
  console.log(`✨ OpenAI Codex Web Harness (Dual-View React):`);
  console.log(`   👉 http://localhost:${PORT}`);
  console.log(`   ⌨️ Phím tắt: Ctrl + ~ chuyển tức thì giữa UI & Terminal`);
  console.log(`======================================================\n`);
});

// 4. Native PTY Terminal WebSocket
const wss = new WebSocketServer({ server, path: "/ws/terminal" });

wss.on("connection", (ws) => {
  const shell = process.env.SHELL || "/bin/zsh";
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 28,
    cwd: projectRoot,
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
