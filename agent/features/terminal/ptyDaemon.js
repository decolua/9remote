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

// PID file so the updater + app can find & kill us on demand. Kept in the
// same layout as agent/cloudflared PIDs (see agent/cli/utils/pids.js).
const PID_FILE = path.join(SOCKET_DIR, "pids", "ptyDaemon.pid");

// Sessions: sessionId -> { pty, buffer, name, createdAt }
const sessions = new Map();

// Connected clients (main server connections)
const clients = new Set();

// Constants
const MAX_BUFFER_SIZE = 50 * 1024; // 50KB per session
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB log file limit

// Log file path
const LOG_PATH = path.join(SOCKET_DIR, "daemon.log");

/**
 * Check and truncate log file if exceeds limit
 */
function checkLogSize() {
  try {
    if (fs.existsSync(LOG_PATH)) {
      const stats = fs.statSync(LOG_PATH);
      if (stats.size > MAX_LOG_SIZE) {
        // Keep last 1MB of logs
        const content = fs.readFileSync(LOG_PATH, "utf8");
        const truncated = content.slice(-1024 * 1024);
        fs.writeFileSync(LOG_PATH, truncated);
      }
    }
  } catch (e) {
    // Ignore log management errors
  }
}

/**
 * Log error with timestamp to file
 */
function logError(message, error = null) {
  checkLogSize();
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] ERROR: ${message}`;
  if (error) {
    logLine += ` - ${error.message || error}`;
  }
  logLine += "\n";
  
  try {
    fs.appendFileSync(LOG_PATH, logLine);
  } catch (e) {
    // Ignore write errors
  }
  
  // Also output to stderr for immediate visibility
  console.error(logLine.trim());
}

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
  // Codespaces environment
  if (process.env.CODESPACES === "true") {
    return process.env.CODESPACE_VSCODE_FOLDER || "/workspaces";
  }
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Build shell environment
 */
function buildShellEnv() {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8"
  };
  
  // Inject shell integration to track working directory
  const shell = getDefaultShell();
  const isZsh = shell.includes("zsh");
  const isBash = shell.includes("bash");
  
  if (isZsh) {
    // For zsh: use precmd hook to emit OSC 7
    env.ZDOTDIR = env.ZDOTDIR || env.HOME;
    const precmdHook = `
precmd() {
  print -Pn "\\e]7;file://%m\${PWD}\\e\\\\"
}
`;
    env._9REMOTE_PRECMD = precmdHook;
  } else if (isBash) {
    // For bash: use PROMPT_COMMAND
    const existingPrompt = env.PROMPT_COMMAND || "";
    env.PROMPT_COMMAND = `printf "\\e]7;file://%s\\a" "\${HOSTNAME}\${PWD}"${existingPrompt ? `; ${existingPrompt}` : ""}`;
  }
  
  return env;
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
  const cwd = getDefaultCwd();
  
  try {
    const shellEnv = buildShellEnv();
    shellEnv.NINE_REMOTE_SESSION_ID = sessionId;
    
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: shellEnv,
      useConpty: process.platform === "win32"
    });

    const session = {
      pty: ptyProcess,
      buffer: [],
      name: name || `Terminal ${sessions.size + 1}`,
      createdAt: Date.now(),
      cwd // Store initial cwd
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

    ptyProcess.onExit(() => {
      sessions.delete(sessionId);
      broadcast({ type: "sessionClosed", sessionId });
    });

    sessions.set(sessionId, session);
    return { success: true, sessionId, cwd };
  } catch (error) {
    logError("Failed to create session", error);
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
      send(client, { type: "joinResult", success: true, name: session.name, cwd: session.cwd, requestId: payload.requestId });
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
      logError(`Unknown message type: ${type}`);
  }
}

/**
 * Start daemon server
 */
function startDaemon() {

  // Ensure socket directory exists
  if (!fs.existsSync(SOCKET_DIR)) {
    try {
      fs.mkdirSync(SOCKET_DIR, { recursive: true });
    } catch (e) {
      logError("Failed to create socket directory", e);
      process.exit(1);
    }
  }

  // Remove stale socket file
  if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch (e) {
      logError("Failed to remove stale socket", e);
      process.exit(1);
    }
  }

  const server = net.createServer((client) => {
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
            logError("Invalid message", line);
          }
        }
      }
    });

    client.on("close", () => {
      clients.delete(client);
    });

    client.on("error", (err) => {
      logError("Client error", err);
      clients.delete(client);
    });
  });

  server.on("error", (err) => {
    logError("Server error", err);
    if (err.code === "EADDRINUSE") {
      logError("Socket already in use, exiting");
    }
    process.exit(1);
  });

  server.listen(SOCKET_PATH);

  // Write own PID so the updater / app can kill us by PID only. Kill-by-image
  // (taskkill /IM node.exe) would nuke unrelated node processes on the machine.
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {}

  const cleanupAndExit = () => {
    for (const [, session] of sessions) {
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }
    try { server.close(); } catch {}
    if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
      try { fs.unlinkSync(SOCKET_PATH); } catch {}
    }
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };

  // Graceful shutdown
  process.on("SIGTERM", cleanupAndExit);
  process.on("SIGINT", cleanupAndExit);
}

// Run daemon
startDaemon();
