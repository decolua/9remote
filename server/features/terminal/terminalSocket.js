// Terminal Socket.IO namespace
import pty from "node-pty";
import os from "os";
import fs from "fs";
import path from "path";
import { isRemoteAvailable } from "../remote/remoteSocket.js";

// Store sessions: sessionId -> { pty, name, createdAt, buffer }
const sessions = new Map();

// Upload directory
const UPLOAD_DIR = "/tmp/9remote-uploads";

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Codespaces heartbeat management
let activeConnections = 0;
let heartbeatInterval = null;
const HEARTBEAT_INTERVAL_MS = 60000; // 60 seconds

function isCodespaces() {
  return process.env.CODESPACES === "true";
}

function getCodespaceInfo() {
  if (!isCodespaces()) return null;
  return {
    isCodespaces: true,
    codespaceName: process.env.CODESPACE_NAME || "unknown"
  };
}

function startCodespaceHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    process.memoryUsage();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopCodespaceHeartbeat() {
  if (!heartbeatInterval) return;
  console.log("⏸️ Stopping Codespaces heartbeat");
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

function getDefaultShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

function getDefaultCwd() {
  // If running in Codespaces, default to /workspaces
  if (isCodespaces()) {
    return "/workspaces";
  }
  return os.homedir();
}

function buildShellEnv() {
  const home = os.homedir();
  const user = os.userInfo().username;
  const shell = getDefaultShell();

  const env = { ...process.env };

  Object.assign(env, {
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: shell,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "en_US.UTF-8",
    PWD: home,
    OLDPWD: home,
    TMPDIR: env.TMPDIR || (process.platform === "win32" ? env.TEMP || env.TMP : "/tmp"),
    __CF_USER_TEXT_ENCODING: env.__CF_USER_TEXT_ENCODING,
    XPC_FLAGS: env.XPC_FLAGS,
    XPC_SERVICE_NAME: env.XPC_SERVICE_NAME,
    SSH_AUTH_SOCK: env.SSH_AUTH_SOCK,
    TERM_PROGRAM: "9Remote",
    TERM_PROGRAM_VERSION: "1.0.0",
    ITERM_SESSION_ID: `9remote-${Date.now()}`,
    SHLVL: "1"
  });

  return env;
}

export function setupTerminalSocket(io) {
  io.on("connection", (socket) => {
    console.log(`📟 Terminal client connected: ${socket.id}`);
    
    // Track connections for Codespaces heartbeat
    activeConnections++;
    if (isCodespaces() && activeConnections === 1) {
      startCodespaceHeartbeat();
    }

    // Send server info immediately on connect (include Codespace info)
    socket.emit("serverInfo", { 
      remoteAvailable: isRemoteAvailable(),
      ...getCodespaceInfo()
    });

    // Get list of active sessions
    socket.on("getSessions", (callback) => {
      const list = [];
      for (const [id, session] of sessions) {
        list.push({
          id,
          name: session.name,
          createdAt: session.createdAt
        });
      }
      callback(list);
    });

    // Create new session
    socket.on("createSession", ({ name }, callback) => {
      const sessionId = `session-${Date.now()}`;
      const shell = getDefaultShell();
      const shellEnv = buildShellEnv();
      const defaultCwd = getDefaultCwd();

      try {
        // Cross-platform: Windows shells don't support -l flag
        const shellArgs = process.platform === "win32" ? [] : ["-l"];
        const ptyProcess = pty.spawn(shell, shellArgs, {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: defaultCwd,
          env: shellEnv,
          useConpty: false
        });

        const sessionData = {
          pty: ptyProcess,
          name: name || `Terminal ${sessions.size + 1}`,
          createdAt: Date.now(),
          buffer: []
        };

        // Buffer output (max 50KB)
        const MAX_BUFFER_SIZE = 50 * 1024;
        ptyProcess.onData((data) => {
          sessionData.buffer.push(data);
          let totalSize = sessionData.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
          while (totalSize > MAX_BUFFER_SIZE && sessionData.buffer.length > 1) {
            const removed = sessionData.buffer.shift();
            totalSize -= removed.length;
          }

          // Broadcast to ALL clients listening to this session
          io.emit("output", { sessionId, data: Buffer.from(data, "utf-8") });
        });

        sessions.set(sessionId, sessionData);
        console.log(`PTY created: sessionId=${sessionId}, name=${name}`);

        ptyProcess.onExit(({ exitCode }) => {
          console.log(`PTY exited: sessionId=${sessionId}, code=${exitCode}`);
          sessions.delete(sessionId);
          io.emit("sessionClosed", sessionId);
        });

        callback({ success: true, sessionId });
      } catch (error) {
        console.error("Failed to create session:", error);
        callback({ success: false, error: error.message });
      }
    });

    // Join session - just send buffered history
    socket.on("joinSession", (sessionId, callback) => {
      const session = sessions.get(sessionId);
      if (!session) {
        callback({ success: false, error: "Session not found" });
        return;
      }

      // Replay buffered output
      if (session.buffer && session.buffer.length > 0) {
        const history = session.buffer.join("");
        socket.emit("output", { sessionId, data: Buffer.from(history, "utf-8") });
      }

      callback({ success: true, name: session.name });
    });

    // Terminal input
    socket.on("input", ({ sessionId, data }) => {
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (session) {
        const input = Buffer.isBuffer(data) ? data.toString("utf-8") : data;
        session.pty.write(input);
      }
    });

    // Handle file upload
    socket.on("upload-file", ({ sessionId, filename, size, type, content }) => {
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;

      try {
        // Generate unique filename to avoid conflicts
        const timestamp = Date.now();
        const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const finalFilename = `${timestamp}_${safeFilename}`;
        const filePath = path.join(UPLOAD_DIR, finalFilename);

        // Decode base64 and save file
        const buffer = Buffer.from(content, "base64");
        fs.writeFileSync(filePath, buffer);

        console.log(`📎 File uploaded: ${filePath} (${size} bytes)`);

        // Paste file path into terminal
        session.pty.write(filePath);

      } catch (error) {
        console.error("File upload error:", error);
        socket.emit("output", { 
          sessionId, 
          data: Buffer.from(`\r\nError uploading file: ${error.message}\r\n`, "utf-8") 
        });
      }
    });

    // Handle resize
    socket.on("resize", ({ sessionId, cols, rows }) => {
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (session) {
        session.pty.resize(cols, rows);
      }
    });

    // Delete session
    socket.on("deleteSession", (sessionId, callback) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.pty.kill();
        sessions.delete(sessionId);
        callback({ success: true });
      } else {
        callback({ success: false, error: "Session not found" });
      }
    });

    // Rename session
    socket.on("renameSession", ({ sessionId, name }, callback) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.name = name;
        callback({ success: true });
      } else {
        callback({ success: false, error: "Session not found" });
      }
    });

    socket.on("disconnect", () => {
      console.log(`📟 Terminal client disconnected: ${socket.id}`);
      
      // Track disconnections for Codespaces heartbeat
      activeConnections--;
      if (isCodespaces() && activeConnections === 0) {
        stopCodespaceHeartbeat();
      }
    });
  });
}
