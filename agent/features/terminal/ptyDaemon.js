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
import { resolveShell, DAEMON_VERSION } from "./constants.js";

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
const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB raw fallback per session
const JOIN_REPLAY_SIZE = 128 * 1024; // 128KB tail on join — older history fetched on scroll-up
const HISTORY_CHUNK_SIZE = 128 * 1024; // 128KB per scroll-up fetch chunk
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB log file limit

// Buffer storage = Buffer[] (byte-accurate). The web mirror also counts BYTES, so total/have
// stay consistent across CJK/emoji/ANSI output. (Previously string[] + char-length → offset
// drift on multibyte → "load more" loaded wrong/duplicate segments.)
// Walk chunks from the end — avoid joining full ≤2MB buffer just to keep a tail
function takeBufferTail(chunks, maxLen) {
  if (!chunks?.length || maxLen <= 0) return Buffer.alloc(0);
  let remaining = maxLen;
  const parts = [];
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = chunks[i];
    if (chunk.length <= remaining) {
      parts.push(chunk);
      remaining -= chunk.length;
    } else {
      parts.push(chunk.subarray(chunk.length - remaining));
      remaining = 0;
    }
  }
  parts.reverse();
  return Buffer.concat(parts);
}

// Total byte length of a chunked Buffer[]
function bufferTotal(chunks) {
  if (!chunks?.length) return 0;
  return chunks.reduce((sum, c) => sum + c.length, 0);
}

// Walk chunks from the start — used by requestHistory to send prefix older than the tail
function takeBufferHead(chunks, maxLen) {
  if (!chunks?.length || maxLen <= 0) return Buffer.alloc(0);
  let remaining = maxLen;
  const parts = [];
  for (let i = 0; i < chunks.length && remaining > 0; i++) {
    const chunk = chunks[i];
    if (chunk.length <= remaining) {
      parts.push(chunk);
      remaining -= chunk.length;
    } else {
      parts.push(chunk.subarray(0, remaining));
      remaining = 0;
    }
  }
  return Buffer.concat(parts);
}

// Return up to chunkLen bytes ending at (total - haveFromEnd), i.e. the slice just before the
// tail the client already holds. The raw slice may start mid-ANSI-sequence/mid-UTF8 → xterm
// parser chokes. Align the START to the next '\n' after the raw start so every chunk begins at
// a line boundary (ANSI sequences rarely span '\n'). The trimmed head is folded back into the
// remaining history (reported via ackRemaining) so the next fetch covers it.
function takeBufferRange(chunks, haveFromEnd, chunkLen) {
  if (!chunks?.length || chunkLen <= 0) return { prefix: Buffer.alloc(0), trimmed: 0 };
  const total = bufferTotal(chunks);
  const endExclusive = total - Math.max(0, Math.min(haveFromEnd, total)); // absolute end offset
  let start = endExclusive - chunkLen;
  if (start < 0) { chunkLen += start; start = 0; }
  if (chunkLen <= 0) return { prefix: Buffer.alloc(0), trimmed: 0 };

  // Walk forward accumulating byte offset until we reach `start`, then collect chunkLen bytes.
  let offset = 0;
  const parts = [];
  for (let i = 0; i < chunks.length && chunkLen > 0; i++) {
    const chunk = chunks[i];
    const next = offset + chunk.length;
    if (next <= start) { offset = next; continue; }
    if (offset >= endExclusive) break;
    const localStart = Math.max(0, start - offset);
    const take = Math.min(chunkLen, chunk.length - localStart);
    parts.push(chunk.subarray(localStart, localStart + take));
    chunkLen -= take;
    offset = next;
  }
  let raw = Buffer.concat(parts);

  // Align start to the next '\n' (0x0A) so we don't begin mid-line/mid-sequence.
  let trimmed = 0;
  const nl = raw.indexOf(0x0a);
  if (nl > 0 && nl < raw.length - 1) {
    trimmed = nl + 1;
    raw = raw.subarray(trimmed);
  }
  return { prefix: raw, trimmed };
}

// DEC private modes we restore on replay — alt buffer + mouse tracking/encoding
const RESTORE_MODES = ["1049", "1047", "1000", "1002", "1003", "1006", "1015", "1005"];
const DEC_PRIVATE_RE = /\x1b\[\?([0-9;]+)([hl])/g;

// Track terminal modes from PTY output so reconnect replay can re-emit them
function applyModes(modes, data) {
  if (typeof data !== "string") data = String(data);
  for (const m of data.matchAll(DEC_PRIVATE_RE)) {
    const set = m[2] === "h";
    for (const n of m[1].split(";")) modes[set ? "add" : "delete"](`?${n}`);
  }
}

function restoreSeq(modes) {
  const active = RESTORE_MODES.filter((n) => modes.has(`?${n}`));
  return active.length ? `\x1b[?${active.join(";")}h` : "";
}

// Log file path — under ~/.9remote/logs/ for consistency with agent.log
const LOG_DIR = path.join(SOCKET_DIR, "logs");
const LOG_PATH = path.join(LOG_DIR, "daemon.log");
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

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
 * Build shell environment based on selected shell path
 */
function buildShellEnv(shellPath) {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8"
  };
  // Don't leak 9remote's internal PORT=2208 into user shells (breaks their npm run dev)
  delete env.PORT;

  const isZsh = shellPath.includes("zsh");
  const isBash = shellPath.includes("bash");

  let zdotDir = null;
  if (isZsh) {
    // zsh ignores a bare env hook; write a real .zshrc into a temp ZDOTDIR so precmd fires.
    zdotDir = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-zsh-"));
    const tmpZshrc = path.join(zdotDir, ".zshrc");
    const homeZshrc = env.HOME ? path.join(env.HOME, ".zshrc") : null;
    let body = 'precmd() { print -Pn "\\e]7;file://%m${PWD}\\e\\\\" }\n';
    if (homeZshrc && fs.existsSync(homeZshrc)) {
      body += `[ -f "${homeZshrc}" ] && source "${homeZshrc}"\n`;
    }
    fs.writeFileSync(tmpZshrc, body);
    env.ZDOTDIR = zdotDir;
  } else if (isBash) {
    const existingPrompt = env.PROMPT_COMMAND || "";
    env.PROMPT_COMMAND = `printf "\\e]7;file://%s\\a" "\${HOSTNAME}\${PWD}"${existingPrompt ? `; ${existingPrompt}` : ""}`;
  }

  return { env, zdotDir };
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
function createSession(sessionId, name, cols = 80, rows = 24, shellId = null, cwd = null) {
  if (sessions.has(sessionId)) {
    return { success: false, error: "Session already exists" };
  }

  const shellConfig = resolveShell(shellId);
  // Agent-supplied cwd (restore prior dir); fall back to default if missing/invalid
  if (!cwd || !fs.existsSync(cwd)) cwd = getDefaultCwd();

  try {
    const { env: shellEnv, zdotDir } = buildShellEnv(shellConfig.path);
    shellEnv.NINE_REMOTE_SESSION_ID = sessionId;

    const ptyProcess = pty.spawn(shellConfig.path, shellConfig.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: shellEnv,
      useConpty: process.platform === "win32"
    });

    // Inject OSC 7 cwd tracking for powershell/pwsh after spawn
    if (shellConfig.id === "powershell" || shellConfig.id === "pwsh") {
      const prompt = `function prompt { $p = $PWD.Path -replace '\\\\','/'; "$([char]27)]7;file://$([System.Net.Dns]::GetHostName())$p$([char]27)\\PS $($PWD.Path)> " }\r\n`;
      setTimeout(() => { try { ptyProcess.write(prompt); } catch {} }, 500);
    }

    const session = {
      pty: ptyProcess,
      buffer: [],
      modes: new Set(),
      name,
      createdAt: Date.now(),
      cwd,
      shellId: shellConfig.id,
      shellLabel: shellConfig.label,
      zdotDir,
      pending: null,          // coalesced output (concat of same-tick chunks)
      flushScheduled: false   // setImmediate flush guard
    };

    // Coalesce same-tick onData chunks into one output packet. setImmediate runs after
    // the poll phase (~0.1ms), so a lone keystroke echo flushes immediately while TUI
    // redraw bursts collapse to a single packet. Rapid-typing lag is NOT caused by this
    // (it was the agent's sync git spawn on every keystroke — fixed in GitHandler).
    const flushOutput = () => {
      session.flushScheduled = false;
      const pending = session.pending;
      if (!pending) return;
      session.pending = null;
      broadcast({
        type: "output",
        sessionId,
        enc: "b64",
        data: Buffer.from(pending).toString("base64")
      });
    };

    // Buffer output and broadcast to clients
    ptyProcess.onData((data) => {
      // Store as Buffer (byte-accurate) — web mirror counts bytes, so total/have stay
      // consistent across CJK/emoji. applyModes + OSC 7 parse keep using the raw `data` string.
      session.buffer.push(Buffer.from(data, "utf-8"));
      // Track terminal modes (alt buffer, mouse) so reconnect replay can restore them
      applyModes(session.modes, data);
      // Track live cwd from OSC 7 escape: \e]7;file://host/path\a (or ST terminator)
      const osc7 = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)/);
      if (osc7) {
        let next;
        try { next = decodeURIComponent(osc7[1]); } catch { next = osc7[1]; }
        if (next && next !== session.cwd) {
          session.cwd = next;
          broadcast({ type: "cwdChange", sessionId, cwd: next });
        }
      }
      // Trim by BYTE length keeping the tail — avoids cutting whole chunks mid-ANSI/mid-UTF8
      const totalSize = bufferTotal(session.buffer);
      if (totalSize > MAX_BUFFER_SIZE) {
        session.buffer = [takeBufferTail(session.buffer, MAX_BUFFER_SIZE)];
      }

      // Coalesce: append to pending, schedule one flush at end of this tick.
      session.pending = session.pending === null ? data : session.pending + data;
      if (!session.flushScheduled) {
        session.flushScheduled = true;
        setImmediate(flushOutput);
      }
    });

    ptyProcess.onExit(() => {
      sessions.delete(sessionId);
      if (session.zdotDir) fs.rm(session.zdotDir, { recursive: true, force: true }, () => {});
      broadcast({ type: "sessionClosed", sessionId });
    });

    sessions.set(sessionId, session);
    return { success: true, sessionId, cwd, shellId: shellConfig.id, shellLabel: shellConfig.label };
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
      send(client, { type: "pong", version: DAEMON_VERSION, requestId: payload.requestId });
      break;

    case "listSessions":
      const list = Array.from(sessions.entries()).map(([id, s]) => ({
        id,
        name: s.name,
        createdAt: s.createdAt,
        shellId: s.shellId,
        shellLabel: s.shellLabel,
        cwd: s.cwd
      }));
      send(client, { type: "sessionList", sessions: list, requestId: payload.requestId });
      break;

    case "createSession":
      const createResult = createSession(
        sessionId || `session-${Date.now()}`,
        payload.name,
        payload.cols,
        payload.rows,
        payload.shellId,
        payload.cwd
      );
      send(client, { type: "createResult", ...createResult, requestId: payload.requestId });
      break;

    case "joinSession":
      const session = sessions.get(sessionId);
      if (!session) {
        send(client, { type: "joinResult", success: false, error: "Session not found", requestId: payload.requestId });
        return;
      }
      // Re-emit terminal mode sequences BEFORE history tail — client called reset() on
      // reconnect which wiped alt-buffer/mouse modes; without this, replay lands in the
      // normal buffer and wheel/touch scroll breaks for TUI apps (e.g. opencode).
      const restore = restoreSeq(session.modes);
      if (restore) {
        send(client, { type: "output", sessionId, enc: "b64", data: Buffer.from(restore).toString("base64") });
      }
      // Replay only tail of buffered output to avoid network burst on join
      const history = takeBufferTail(session.buffer, JOIN_REPLAY_SIZE);
      if (history && history.length) {
        send(client, {
          type: "output",
          sessionId,
          enc: "b64",
          data: history.toString("base64")
        });
      }
      // total = bytes agent still holds; web uses it to know the older-history ceiling
      const joinTotal = bufferTotal(session.buffer);
      send(client, { type: "joinResult", success: true, name: session.name, cwd: session.cwd, shellId: session.shellId, shellLabel: session.shellLabel, total: joinTotal, replaySize: history ? history.length : 0, requestId: payload.requestId });
      break;

    case "requestHistory": {
      // Client scrolled to top → return a CHUNK of bytes just before the bytes it holds.
      // have = bytes the client currently has (its tail). We return the newest older chunk:
      // buffer[total-have-chunkLen .. total-have]. Client splices it before its mirror and
      // replays, then re-requests for the next older chunk. Prefix travels in the ack (not a
      // broadcast output) so only the requesting socket receives it.
      const hSession = sessions.get(sessionId);
      if (!hSession) {
        send(client, { type: "historyResult", success: false, error: "Session not found", requestId: payload.requestId });
        return;
      }
      const total = bufferTotal(hSession.buffer);
      const have = Math.max(0, Math.min(payload.have || 0, total));
      const remaining = total - have;          // bytes older than what client holds
      const chunkLen = Math.min(HISTORY_CHUNK_SIZE, remaining);
      const { prefix, trimmed } = chunkLen > 0 ? takeBufferRange(hSession.buffer, have, chunkLen) : { prefix: Buffer.alloc(0), trimmed: 0 };
      send(client, {
        type: "historyResult",
        success: true,
        sessionId,
        enc: "b64",
        prefix: prefix && prefix.length ? prefix.toString("base64") : "",
        prefixLen: prefix ? prefix.length : 0,
        total,
        // remaining = older bytes not yet sent. trimmed (line-align head) stays unsent → add back.
        remaining: Math.max(0, remaining - prefix.length - trimmed) + trimmed,
        requestId: payload.requestId
      });
      break;
    }

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

    case "getCwd":
      const cwdSession = sessions.get(sessionId);
      send(client, { type: "cwdResult", cwd: cwdSession?.cwd || null, requestId: payload.requestId });
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

  server.listen(SOCKET_PATH, () => {
    if (process.platform !== "win32") {
      try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
    }
  });

  // Write own PID so the updater / app can kill us by PID only. Kill-by-image
  // (taskkill /IM node.exe) would nuke unrelated node processes on the machine.
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
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
