#!/usr/bin/env node
/**
 * PTY Daemon - Runs independently from main server
 * Manages PTY sessions that persist across server restarts
 * Communicates via Unix Domain Socket (or Named Pipe on Windows)
 */

import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import pty from "node-pty";

// Socket path
const SOCKET_DIR = path.join(os.homedir(), ".9remote");
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\9remote-pty"
  : path.join(SOCKET_DIR, "pty-daemon.sock");

// Sessions: sessionId -> { pty, buffer, name, createdAt }
const sessions = new Map();

// Connected clients (main server connections)
const clients = new Set();

// Constants
const MAX_BUFFER_SIZE = 50 * 1024; // 50KB per session

/**
 * Get default shell
 */
function getDefaultShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

/**
 * Get default working directory
 */
function getDefaultCwd() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Build shell environment
 */
function buildShellEnv() {
  return {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8"
  };
}

/**
 * Send message to all connected clients
 */
function broadcast(message) {
  const data = JSON.stringify(message) + "\n";
  for (const client of clients) {
    try {
      client.write(data);
    } catch (e) {
      // Client disconnected
    }
  }
}

/**
 * Send message to specific client
 */
function send(client, message) {
  try {
    client.write(JSON.stringify(message) + "\n");
  } catch (e) {
    // Client disconnected
  }
}

/**
 * Create new PTY session
 */
function createSession(sessionId, name, cols = 80, rows = 24) {
  if (sessions.has(sessionId)) {
    return { success: false, error: "Session already exists" };
  }

  const shell = getDefaultShell();
  const shellArgs = process.platform === "win32" ? [] : ["-l"];
  
  try {
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: getDefaultCwd(),
      env: buildShellEnv(),
      useConpty: process.platform === "win32"
    });

    const session = {
      pty: ptyProcess,
      buffer: [],
      name: name || `Terminal ${sessions.size + 1}`,
      createdAt: Date.now()
    };

    // Buffer output and broadcast to clients
    ptyProcess.onData((data) => {
      session.buffer.push(data);
      let totalSize = session.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
      while (totalSize > MAX_BUFFER_SIZE && session.buffer.length > 1) {
        session.buffer.shift();
        totalSize = session.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
      }

      broadcast({
        type: "output",
        sessionId,
        data: Buffer.from(data).toString("base64")
      });
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[Daemon] PTY exited: ${sessionId}, code=${exitCode}`);
      sessions.delete(sessionId);
      broadcast({ type: "sessionClosed", sessionId });
    });

    sessions.set(sessionId, session);
    console.log(`[Daemon] Session created: ${sessionId}`);
    
    return { success: true, sessionId };
  } catch (error) {
    console.error(`[Daemon] Failed to create session:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle client messages
 */
function handleMessage(client, message) {
  const { type, sessionId, ...payload } = message;

  switch (type) {
    case "ping":
      send(client, { type: "pong" });
      break;

    case "listSessions":
      const list = Array.from(sessions.entries()).map(([id, s]) => ({
        id,
        name: s.name,
        createdAt: s.createdAt
      }));
      send(client, { type: "sessionList", sessions: list, requestId: payload.requestId });
      break;

    case "createSession":
      const createResult = createSession(
        payload.sessionId || `session-${Date.now()}`,
        payload.name,
        payload.cols,
        payload.rows
      );
      send(client, { type: "createResult", ...createResult, requestId: payload.requestId });
      break;

    case "joinSession":
      const session = sessions.get(sessionId);
      if (!session) {
        send(client, { type: "joinResult", success: false, error: "Session not found", requestId: payload.requestId });
        return;
      }
      // Send buffered output
      if (session.buffer.length > 0) {
        const history = session.buffer.join("");
        send(client, {
          type: "output",
          sessionId,
          data: Buffer.from(history).toString("base64")
        });
      }
      send(client, { type: "joinResult", success: true, name: session.name, requestId: payload.requestId });
      break;

    case "input":
      const inputSession = sessions.get(sessionId);
      if (inputSession?.pty) {
        inputSession.pty.write(payload.data);
      }
      break;

    case "resize":
      const resizeSession = sessions.get(sessionId);
      if (resizeSession?.pty) {
        try {
          resizeSession.pty.resize(payload.cols, payload.rows);
        } catch (e) {
          // Ignore resize errors
        }
      }
      break;

    case "deleteSession":
      const delSession = sessions.get(sessionId);
      if (delSession) {
        if (delSession.pty) {
          delSession.pty.kill();
        }
        sessions.delete(sessionId);
        broadcast({ type: "sessionClosed", sessionId });
        send(client, { type: "deleteResult", success: true, requestId: payload.requestId });
      } else {
        send(client, { type: "deleteResult", success: false, error: "Session not found", requestId: payload.requestId });
      }
      break;

    case "renameSession":
      const renameSession = sessions.get(sessionId);
      if (renameSession) {
        renameSession.name = payload.name;
        broadcast({ type: "sessionRenamed", sessionId, name: payload.name });
        send(client, { type: "renameResult", success: true, requestId: payload.requestId });
      } else {
        send(client, { type: "renameResult", success: false, error: "Session not found", requestId: payload.requestId });
      }
      break;

    default:
      console.log(`[Daemon] Unknown message type: ${type}`);
  }
}

/**
 * Start daemon server
 */
function startDaemon() {
  console.log("[Daemon] Starting PTY Daemon...");
  console.log("[Daemon] PID:", process.pid);
  console.log("[Daemon] Node version:", process.version);
  console.log("[Daemon] Platform:", process.platform);
  console.log("[Daemon] Socket dir:", SOCKET_DIR);
  console.log("[Daemon] Socket path:", SOCKET_PATH);

  // Ensure socket directory exists
  if (!fs.existsSync(SOCKET_DIR)) {
    try {
      fs.mkdirSync(SOCKET_DIR, { recursive: true });
      console.log("[Daemon] Created socket directory");
    } catch (e) {
      console.error("[Daemon] Failed to create socket directory:", e);
      process.exit(1);
    }
  }

  // Remove stale socket file
  if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
      console.log("[Daemon] Removed stale socket file");
    } catch (e) {
      console.error("[Daemon] Failed to remove stale socket:", e);
      process.exit(1);
    }
  }

  const server = net.createServer((client) => {
    console.log("[Daemon] Client connected");
    clients.add(client);

    let buffer = "";

    client.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            handleMessage(client, message);
          } catch (e) {
            console.error("[Daemon] Invalid message:", line);
          }
        }
      }
    });

    client.on("close", () => {
      console.log("[Daemon] Client disconnected");
      clients.delete(client);
    });

    client.on("error", (err) => {
      console.error("[Daemon] Client error:", err.message);
      clients.delete(client);
    });
  });

  server.on("error", (err) => {
    console.error("[Daemon] Server error:", err);
    if (err.code === "EADDRINUSE") {
      console.error("[Daemon] Socket already in use, exiting");
    }
    process.exit(1);
  });

  server.listen(SOCKET_PATH, () => {
    console.log(`[Daemon] ✅ PTY Daemon listening on ${SOCKET_PATH}`);
    console.log(`[Daemon] PID: ${process.pid}`);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[Daemon] Received SIGTERM, shutting down...");
    for (const [id, session] of sessions) {
      if (session.pty) {
        session.pty.kill();
      }
    }
    server.close();
    if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("[Daemon] Received SIGINT, shutting down...");
    process.emit("SIGTERM");
  });
}

// Run daemon
startDaemon();
