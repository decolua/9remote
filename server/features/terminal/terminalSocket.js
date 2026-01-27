// Terminal Socket.IO namespace
import pty from "node-pty";
import os from "os";
import fs from "fs";
import path from "path";
import { isRemoteAvailable } from "../remote/remoteSocket.js";
import { 
  ensureZellij, 
  isZellijAvailable, 
  listZellijSessions,
  attachZellijSession,
  killZellijSession,
  getZellijSessionInfo
} from "../../utils/zellij.js";

// Store sessions: sessionId -> { pty, name, createdAt, buffer, zellijSession }
const sessions = new Map();

// Zellij availability flag
let zellijEnabled = false;

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
      if (session.zellijSession) {
        metadata[id] = {
          name: session.name,
          createdAt: session.createdAt,
          zellijSession: session.zellijSession
        };
      }
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
  postAttachCommand: "9remote",
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
    const enabled = config.postAttachCommand === "9remote";
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
      config.postAttachCommand = "9remote";
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

/**
 * Initialize Zellij and restore sessions
 */
export async function initializeZellij() {
  try {
    await ensureZellij();
    zellijEnabled = true;
    console.log("✅ Zellij enabled - sessions will persist");
    
    // Load saved session metadata (names, etc)
    const savedMetadata = loadSessionMetadata();
    
    // Restore existing Zellij sessions
    const existingSessions = await listZellijSessions();
    for (const session of existingSessions) {
      // Parse sessionId from Zellij session name (format: 9remote-{sessionId})
      const match = session.name.match(/^9remote-(.+)$/);
      if (match) {
        const sessionId = match[1];
        
        // Get saved metadata or use default
        const metadata = savedMetadata[sessionId] || {};
        const sessionName = metadata.name || `Terminal ${sessions.size + 1}`;
        const createdAt = metadata.createdAt || Date.now();
        
        console.log(`🔄 Restored session: ${sessionId} (${sessionName})`);
        
        sessions.set(sessionId, {
          zellijSession: session.name,
          name: sessionName,
          createdAt: createdAt,
          buffer: [],
          restored: true,
          needsAttach: true
        });
      }
    }
    
    if (existingSessions.length > 0) {
      console.log(`✅ Restored ${existingSessions.length} session(s)`);
    }
  } catch (error) {
    console.log("⚠️  Zellij not available - sessions will not persist");
    console.log("   Install Zellij for full session persistence: https://zellij.dev");
    zellijEnabled = false;
  }
}

export function setupTerminalSocket(io) {
  io.on("connection", (socket) => {
    console.log(`📟 Terminal client connected: ${socket.id}`);
    
    // Track connections for Codespaces heartbeat
    activeConnections++;
    if (isCodespaces() && activeConnections === 1) {
      startCodespaceHeartbeat();
    }

    // Send server info immediately on connect (include Codespace info and Zellij status)
    socket.emit("serverInfo", { 
      remoteAvailable: isRemoteAvailable(),
      zellijEnabled,
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
        let sessionData;
        
        if (zellijEnabled) {
          // Use Zellij for persistent sessions
          const zellijSessionName = `9remote-${sessionId}`;
          
          try {
            // Attach to Zellij session via PTY
            const ptyProcess = attachZellijSession(zellijSessionName, pty, shellEnv, defaultCwd);
            
            sessionData = {
              pty: ptyProcess,
              zellijSession: zellijSessionName,
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

              io.emit("output", { sessionId, data: Buffer.from(data, "utf-8") });
            });

            ptyProcess.onExit(({ exitCode }) => {
              console.log(`Zellij session exited: ${zellijSessionName}, code=${exitCode}`);
              // Mark PTY as closed
              sessionData.pty = null;
              // Don't delete session - it persists in Zellij
              // Client can reconnect later
            });
            
            console.log(`Zellij session attached: ${zellijSessionName}`);
            
            // Save metadata for persistence
            saveSessionMetadata();
          } catch (error) {
            console.error("Failed to attach Zellij session, falling back to PTY:", error);
            zellijEnabled = false;
          }
        }
        
        if (!zellijEnabled) {
          // Fallback to PTY
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
          ptyProcess.onData((data) => {
            sessionData.buffer.push(data);
            let totalSize = sessionData.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
            while (totalSize > MAX_BUFFER_SIZE && sessionData.buffer.length > 1) {
              const removed = sessionData.buffer.shift();
              totalSize -= removed.length;
            }

            io.emit("output", { sessionId, data: Buffer.from(data, "utf-8") });
          });

          ptyProcess.onExit(({ exitCode }) => {
            console.log(`PTY exited: sessionId=${sessionId}, code=${exitCode}`);
            sessions.delete(sessionId);
            io.emit("sessionClosed", sessionId);
          });
          
          console.log(`PTY created: sessionId=${sessionId}, name=${name}`);
        }

        sessions.set(sessionId, sessionData);
        callback({ success: true, sessionId, zellijEnabled });
      } catch (error) {
        console.error("Failed to create session:", error);
        callback({ success: false, error: error.message });
      }
    });

    // Join session - attach PTY if needed
    socket.on("joinSession", (sessionId, callback) => {
      const session = sessions.get(sessionId);
      if (!session) {
        callback({ success: false, error: "Session not found" });
        return;
      }

      // If session needs attach (restored session), attach PTY now
      if (session.needsAttach && session.zellijSession) {
        try {
          const shell = getDefaultShell();
          const shellEnv = buildShellEnv();
          const defaultCwd = getDefaultCwd();
          
          const ptyProcess = attachZellijSession(session.zellijSession, pty, shellEnv, defaultCwd);
          
          // Update session with PTY
          session.pty = ptyProcess;
          session.needsAttach = false;
          
          // Buffer output
          const MAX_BUFFER_SIZE = 50 * 1024;
          ptyProcess.onData((data) => {
            session.buffer.push(data);
            let totalSize = session.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
            while (totalSize > MAX_BUFFER_SIZE && session.buffer.length > 1) {
              const removed = session.buffer.shift();
              totalSize -= removed.length;
            }

            io.emit("output", { sessionId, data: Buffer.from(data, "utf-8") });
          });

          ptyProcess.onExit(({ exitCode }) => {
            console.log(`Zellij session exited: ${session.zellijSession}, code=${exitCode}`);
            // Mark PTY as closed
            session.pty = null;
            session.needsAttach = true; // Allow re-attach
          });
          
          console.log(`✅ Attached to restored session: ${sessionId}`);
        } catch (error) {
          console.error("Failed to attach restored session:", error);
          callback({ success: false, error: "Failed to attach session" });
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
        const input = Buffer.isBuffer(data) ? data.toString("utf-8") : data;
        if (session.pty) {
          session.pty.write(input);
        }
        // Note: Zellij sessions handle input through attach mechanism
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
        if (session.pty) {
          session.pty.write(filePath);
        }
        // Note: Zellij sessions handle file paths through attach mechanism

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
      if (session && session.pty) {
        try {
          session.pty.resize(cols, rows);
        } catch (error) {
          // PTY might be closed, ignore error
          console.log(`Resize failed for ${sessionId}: ${error.message}`);
        }
      }
      // Note: Zellij handles resize automatically
    });

    // Delete session
    socket.on("deleteSession", (sessionId, callback) => {
      const session = sessions.get(sessionId);
      if (session) {
        if (session.zellijSession) {
          // Kill Zellij session
          killZellijSession(session.zellijSession);
        } else if (session.pty) {
          // Kill PTY
          session.pty.kill();
        }
        sessions.delete(sessionId);
        io.emit("sessionClosed", sessionId);
        // Save metadata for persistence
        saveSessionMetadata();
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
        // Broadcast to all clients that session was renamed
        io.emit("session-renamed", { sessionId, name });
        // Save metadata for persistence
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
