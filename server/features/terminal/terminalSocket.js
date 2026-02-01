// Terminal Socket.IO namespace
import pty from "node-pty";
import os from "os";
import fs from "fs";
import path from "path";
import { isRemoteAvailable } from "../remote/remoteSocket.js";
import * as daemonClient from "./ptyDaemonClient.js";
import chalk from "chalk";

const ORANGE = chalk.rgb(230, 138, 110);

// Store sessions: sessionId -> { pty, name, createdAt, buffer, daemon }
const sessions = new Map();

// Persistence mode:
// - "daemon": PTY Daemon (persistent + scrollback) ⭐ Recommended
// - "buffer": PTY + file persistence (scrollback, no process persistence)
const PERSISTENCE_MODE = "daemon";

// Session metadata file for preserving names across restarts
const SESSION_METADATA_FILE = path.join(os.homedir(), ".9remote", "sessions.json");

// Upload directory
const UPLOAD_DIR = "/tmp/9remote-uploads";

/**
 * Load session metadata from file
 */
function loadSessionMetadata() {
  try {
    if (fs.existsSync(SESSION_METADATA_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_METADATA_FILE, "utf8"));
    }
  } catch (error) {
    console.log("⚠️  Failed to load session metadata:", error.message);
  }
  return {};
}

/**
 * Save session metadata to file
 */
function saveSessionMetadata() {
  try {
    const metadata = {};
    for (const [id, session] of sessions) {
      metadata[id] = {
        name: session.name,
        createdAt: session.createdAt
      };
    }
    
    const dir = path.dirname(SESSION_METADATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(SESSION_METADATA_FILE, JSON.stringify(metadata, null, 2), "utf8");
  } catch (error) {
    console.log("⚠️  Failed to save session metadata:", error.message);
  }
}

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
    codespaceName: process.env.CODESPACE_NAME || "unknown",
    workspacePath: process.env.CODESPACE_VSCODE_FOLDER || process.cwd()
  };
}

// Devcontainer config for auto start
const DEVCONTAINER_CONFIG = {
  name: "9Remote",
  postCreateCommand: "npm install -g 9remote@latest",
  postAttachCommand: "9remote start",
  forwardPorts: [2208],
  portsAttributes: {
    "2208": {
      label: "9Remote Server",
      onAutoForward: "notify"
    }
  }
};

function getDevcontainerPath(workspacePath) {
  return path.join(workspacePath, ".devcontainer", "devcontainer.json");
}

function getAutoStartStatus(workspacePath) {
  try {
    const devcontainerPath = getDevcontainerPath(workspacePath);
    if (!fs.existsSync(devcontainerPath)) {
      return { enabled: false, exists: false };
    }
    const content = fs.readFileSync(devcontainerPath, "utf8");
    const config = JSON.parse(content);
    const enabled = config.postAttachCommand === "9remote start" || config.postAttachCommand === "9remote";
    return { enabled, exists: true };
  } catch {
    return { enabled: false, exists: false, error: "Failed to read config" };
  }
}

function setAutoStart(workspacePath, enabled) {
  try {
    const devcontainerDir = path.join(workspacePath, ".devcontainer");
    const devcontainerPath = getDevcontainerPath(workspacePath);
    
    // Create .devcontainer directory if not exists
    if (!fs.existsSync(devcontainerDir)) {
      fs.mkdirSync(devcontainerDir, { recursive: true });
    }
    
    let config = { ...DEVCONTAINER_CONFIG };
    
    // If file exists, merge with existing config
    if (fs.existsSync(devcontainerPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(devcontainerPath, "utf8"));
        config = { ...existing };
      } catch {
        // Use default config if parse fails
      }
    }
    
    if (enabled) {
      config.postAttachCommand = "9remote start";
      if (!config.postCreateCommand) {
        config.postCreateCommand = "npm install -g 9remote@latest";
      }
    } else {
      delete config.postAttachCommand;
    }
    
    fs.writeFileSync(devcontainerPath, JSON.stringify(config, null, 2));
    return { success: true, enabled };
  } catch (error) {
    return { success: false, error: error.message };
  }
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

// Buffer persistence directory
const BUFFER_DIR = path.join(os.homedir(), ".9remote", "buffers");

/**
 * Ensure buffer directory exists
 */
function ensureBufferDir() {
  if (!fs.existsSync(BUFFER_DIR)) {
    fs.mkdirSync(BUFFER_DIR, { recursive: true });
  }
}

/**
 * Save session buffer to file
 */
function saveSessionBuffer(sessionId, buffer) {
  if (PERSISTENCE_MODE !== "buffer") return;
  ensureBufferDir();
  const filePath = path.join(BUFFER_DIR, `${sessionId}.buf`);
  try {
    const content = buffer.join("");
    fs.writeFileSync(filePath, content, "utf8");
  } catch (error) {
    console.log(`⚠️  Failed to save buffer for ${sessionId}:`, error.message);
  }
}

/**
 * Load session buffer from file
 */
function loadSessionBuffer(sessionId) {
  if (PERSISTENCE_MODE !== "buffer") return null;
  const filePath = path.join(BUFFER_DIR, `${sessionId}.buf`);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      return content;
    }
  } catch (error) {
    console.log(`⚠️  Failed to load buffer for ${sessionId}:`, error.message);
  }
  return null;
}

/**
 * Delete session buffer file
 */
function deleteSessionBuffer(sessionId) {
  const filePath = path.join(BUFFER_DIR, `${sessionId}.buf`);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    // Ignore
  }
}

/**
 * List saved buffer sessions (for restore)
 */
function listSavedBufferSessions() {
  ensureBufferDir();
  try {
    const files = fs.readdirSync(BUFFER_DIR);
    return files
      .filter(f => f.endsWith(".buf"))
      .map(f => f.replace(".buf", ""));
  } catch (error) {
    return [];
  }
}

// Store daemon IO handler reference
let daemonIo = null;

/**
 * Initialize terminal sessions
 */
export async function initializeTerminal() {
  // Daemon mode - recommended
  if (PERSISTENCE_MODE === "daemon") {
    
    const connected = await daemonClient.initDaemonClient();
    if (!connected) {
      console.error("❌ Failed to connect to PTY daemon, falling back to buffer mode");
    } else {
      // Load existing sessions from daemon
      const daemonSessions = await daemonClient.listSessions();
      for (const s of daemonSessions) {
        sessions.set(s.id, {
          daemon: true,
          name: s.name,
          createdAt: s.createdAt
        });
      }
      
      if (daemonSessions.length > 0) {
        console.log(ORANGE(`✅ Connected to daemon with ${daemonSessions.length} session(s)`));
      } else {
        console.log(ORANGE("✅ Connected to PTY daemon"));
      }
      return;
    }
  }

  // Buffer mode (fallback)
  console.log("📦 Buffer persistence mode - scrollback enabled");
  
  const savedSessions = listSavedBufferSessions();
  const metadata = loadSessionMetadata();
  
  for (const sessionId of savedSessions) {
    const meta = metadata[sessionId] || {};
    sessions.set(sessionId, {
      pty: null,
      name: meta.name || `Terminal ${sessions.size + 1}`,
      createdAt: meta.createdAt || Date.now(),
      buffer: [],
      needsRestore: true
    });
    console.log(`🔄 Found saved session: ${sessionId}`);
  }
  
  if (savedSessions.length > 0) {
    console.log(`✅ Found ${savedSessions.length} saved session(s)`);
  }
}

export function setupTerminalSocket(io) {
  daemonIo = io;
  
  // Setup daemon event handlers (forward to socket.io clients)
  if (PERSISTENCE_MODE === "daemon") {
    daemonClient.on("output", ({ sessionId, data }) => {
      io.emit("output", { sessionId, data });
    });
    
    daemonClient.on("sessionClosed", (sessionId) => {
      sessions.delete(sessionId);
      io.emit("sessionClosed", sessionId);
    });
    
    daemonClient.on("sessionRenamed", ({ sessionId, name }) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.name = name;
      }
      io.emit("session-renamed", { sessionId, name });
    });
  }

  io.on("connection", (socket) => {
    console.log(`📟 Terminal client connected: ${socket.id}`);
    
    // Track connections for Codespaces heartbeat
    activeConnections++;
    if (isCodespaces() && activeConnections === 1) {
      startCodespaceHeartbeat();
    }

    // Send server info immediately on connect
    socket.emit("serverInfo", { 
      remoteAvailable: isRemoteAvailable(),
      daemonMode: PERSISTENCE_MODE === "daemon" && daemonClient.isConnected(),
      platform: process.platform,
      ...getCodespaceInfo()
    });

    // Get list of active sessions
    socket.on("getSessions", (callback) => {
      const list = [];
      for (const [id, session] of sessions) {
        list.push({
          id,
          name: session.name,
          createdAt: session.createdAt,
          restored: session.restored || false
        });
      }
      callback(list);
    });

    // Create new session
    socket.on("createSession", async ({ name }, callback) => {
      const sessionId = `session-${Date.now()}`;
      const shell = getDefaultShell();
      const shellEnv = buildShellEnv();
      const defaultCwd = getDefaultCwd();

      try {
        // Daemon mode
        if (PERSISTENCE_MODE === "daemon" && daemonClient.isConnected()) {
          const result = await daemonClient.createSession(name, 80, 24);
          if (result.success) {
            sessions.set(result.sessionId, {
              daemon: true,
              name: name || `Terminal ${sessions.size + 1}`,
              createdAt: Date.now()
            });
            saveSessionMetadata();
            callback({ success: true, sessionId: result.sessionId });
          } else {
            callback({ success: false, error: result.error });
          }
          return;
        }

        // Buffer mode PTY
        const shellArgs = process.platform === "win32" ? [] : ["-l"];
          const ptyProcess = pty.spawn(shell, shellArgs, {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: defaultCwd,
            env: shellEnv,
            useConpty: false
          });

          sessionData = {
            pty: ptyProcess,
            name: name || `Terminal ${sessions.size + 1}`,
            createdAt: Date.now(),
            buffer: []
          };

          // Buffer output (max 50KB)
          const MAX_BUFFER_SIZE = 50 * 1024;
          let saveTimeout = null;
          
          ptyProcess.onData((data) => {
            sessionData.buffer.push(data);
            let totalSize = sessionData.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
            while (totalSize > MAX_BUFFER_SIZE && sessionData.buffer.length > 1) {
              const removed = sessionData.buffer.shift();
              totalSize -= removed.length;
            }

            io.emit("output", { sessionId, data: Buffer.from(data, "utf-8") });
            
            // Debounced save buffer to file (every 2s of inactivity)
            if (PERSISTENCE_MODE === "buffer") {
              if (saveTimeout) clearTimeout(saveTimeout);
              saveTimeout = setTimeout(() => {
                saveSessionBuffer(sessionId, sessionData.buffer);
              }, 2000);
            }
          });

          ptyProcess.onExit(({ exitCode }) => {
            console.log(`PTY exited: sessionId=${sessionId}, code=${exitCode}`);
            // Save final buffer before deleting
            if (PERSISTENCE_MODE === "buffer" && sessionData.buffer.length > 0) {
              saveSessionBuffer(sessionId, sessionData.buffer);
            }
            sessions.delete(sessionId);
            deleteSessionBuffer(sessionId);
            io.emit("sessionClosed", sessionId);
          });
          
          console.log(`PTY created: sessionId=${sessionId}, name=${name}`);

        sessions.set(sessionId, sessionData);
        saveSessionMetadata();
        callback({ success: true, sessionId });
      } catch (error) {
        console.error("Failed to create session:", error);
        callback({ success: false, error: error.message });
      }
    });

    // Join session - attach PTY if needed
    socket.on("joinSession", async (sessionId, callback) => {
      const session = sessions.get(sessionId);
      if (!session) {
        callback({ success: false, error: "Session not found" });
        return;
      }

      // Daemon mode
      if (session.daemon && daemonClient.isConnected()) {
        try {
          const result = await daemonClient.joinSession(sessionId);
          callback({ success: result.success, name: result.name, error: result.error });
        } catch (e) {
          callback({ success: false, error: e.message });
        }
        return;
      }

      // Buffer mode: restore PTY for saved session
      if (session.needsRestore && PERSISTENCE_MODE === "buffer") {
        try {
          const shell = getDefaultShell();
          const shellEnv = buildShellEnv();
          const defaultCwd = getDefaultCwd();
          const shellArgs = process.platform === "win32" ? [] : ["-l"];
          
          const ptyProcess = pty.spawn(shell, shellArgs, {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: defaultCwd,
            env: shellEnv,
            useConpty: false
          });
          
          session.pty = ptyProcess;
          session.needsRestore = false;
          
          // Load saved buffer
          const savedBuffer = loadSessionBuffer(sessionId);
          if (savedBuffer) {
            session.buffer = [savedBuffer];
          }
          
          // Buffer output with persistence
          const MAX_BUFFER_SIZE = 50 * 1024;
          let saveTimeout = null;
          
          ptyProcess.onData((data) => {
            session.buffer.push(data);
            let totalSize = session.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
            while (totalSize > MAX_BUFFER_SIZE && session.buffer.length > 1) {
              const removed = session.buffer.shift();
              totalSize -= removed.length;
            }

            io.emit("output", { sessionId, data: Buffer.from(data, "utf-8") });
            
            // Debounced save
            if (saveTimeout) clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
              saveSessionBuffer(sessionId, session.buffer);
            }, 2000);
          });

          ptyProcess.onExit(({ exitCode }) => {
            console.log(`PTY exited: sessionId=${sessionId}, code=${exitCode}`);
            if (session.buffer.length > 0) {
              saveSessionBuffer(sessionId, session.buffer);
            }
            sessions.delete(sessionId);
            deleteSessionBuffer(sessionId);
            io.emit("sessionClosed", sessionId);
          });
          
          console.log(`✅ Restored PTY session: ${sessionId}`);
        } catch (error) {
          console.error("Failed to restore session:", error);
          callback({ success: false, error: "Failed to restore session" });
          return;
        }
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
        // Daemon mode
        if (session.daemon && daemonClient.isConnected()) {
          daemonClient.sendInput(sessionId, data);
          return;
        }
        
        const input = Buffer.isBuffer(data) ? data.toString("utf-8") : data;
        if (session.pty) {
          session.pty.write(input);
        }
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
        if (session.daemon && daemonClient.isConnected()) {
          // Daemon mode: send via daemon client
          daemonClient.sendInput(sessionId, filePath);
        } else if (session.pty) {
          // Buffer mode: send via PTY
          session.pty.write(filePath);
        }

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
      if (!session) return;
      
      // Daemon mode
      if (session.daemon && daemonClient.isConnected()) {
        daemonClient.resizeSession(sessionId, cols, rows);
        return;
      }
      
      if (session.pty) {
        try {
          session.pty.resize(cols, rows);
        } catch (error) {
          console.log(`Resize failed for ${sessionId}: ${error.message}`);
        }
      }
    });

    // Delete session
    socket.on("deleteSession", async (sessionId, callback) => {
      const session = sessions.get(sessionId);
      if (session) {
        // Daemon mode
        if (session.daemon && daemonClient.isConnected()) {
          try {
            await daemonClient.deleteSession(sessionId);
            sessions.delete(sessionId);
            saveSessionMetadata();
            callback({ success: true });
          } catch (e) {
            callback({ success: false, error: e.message });
          }
          return;
        }
        
        if (session.pty) {
          session.pty.kill();
        }
        sessions.delete(sessionId);
        deleteSessionBuffer(sessionId);
        io.emit("sessionClosed", sessionId);
        saveSessionMetadata();
        callback({ success: true });
      } else {
        callback({ success: false, error: "Session not found" });
      }
    });

    // Rename session
    socket.on("renameSession", async ({ sessionId, name }, callback) => {
      const session = sessions.get(sessionId);
      if (session) {
        // Daemon mode
        if (session.daemon && daemonClient.isConnected()) {
          try {
            await daemonClient.renameSession(sessionId, name);
            session.name = name;
            saveSessionMetadata();
            callback({ success: true });
          } catch (e) {
            callback({ success: false, error: e.message });
          }
          return;
        }
        
        session.name = name;
        io.emit("session-renamed", { sessionId, name });
        saveSessionMetadata();
        callback({ success: true });
      } else {
        callback({ success: false, error: "Session not found" });
      }
    });

    // Get auto start status (Codespaces only)
    socket.on("getAutoStartStatus", (callback) => {
      if (!isCodespaces()) {
        callback({ success: false, error: "Not in Codespaces" });
        return;
      }
      const workspacePath = process.env.CODESPACE_VSCODE_FOLDER || process.cwd();
      const status = getAutoStartStatus(workspacePath);
      callback({ success: true, ...status });
    });

    // Set auto start (Codespaces only)
    socket.on("setAutoStart", ({ enabled }, callback) => {
      if (!isCodespaces()) {
        callback({ success: false, error: "Not in Codespaces" });
        return;
      }
      const workspacePath = process.env.CODESPACE_VSCODE_FOLDER || process.cwd();
      const result = setAutoStart(workspacePath, enabled);
      callback(result);
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
