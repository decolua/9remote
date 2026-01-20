// Terminal Socket.IO namespace
import pty from "node-pty-prebuilt-multiarch";
import os from "os";
import { isRemoteAvailable } from "../../remote/services/remoteSocket.js";

// Store sessions: sessionId -> { pty, name, createdAt, buffer }
const sessions = new Map();

function getDefaultShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/zsh";
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
    TMPDIR: env.TMPDIR || "/tmp",
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

    // Send server info immediately on connect
    socket.emit("serverInfo", { remoteAvailable: isRemoteAvailable() });

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

      try {
        const ptyProcess = pty.spawn(shell, ["-l"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: os.homedir(),
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
    });
  });
}
