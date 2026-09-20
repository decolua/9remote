#!/usr/bin/env node
// PTY Daemon: manages persistent PTY sessions across server restarts.

import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import pty from "node-pty";
import { resolveShell, buildShellArgs, DAEMON_VERSION } from "./constants.js";
import { createRouter } from "./daemonRouter.js";
import { createKvStore, kvRoutes } from "./daemonKv.js";
import { takeBufferTail, takeBufferRange, bufferTotal } from "./bufferSlice.js";

// NREMOTE_HOME keeps daemon state inside client root to isolate test daemon.
const SOCKET_DIR = process.env.NREMOTE_HOME || path.join(os.homedir(), ".9remote");
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\9remote-pty"
  : path.join(SOCKET_DIR, "pty-daemon.sock");

// PID file for updater and app lifecycle management.
const PID_FILE = path.join(SOCKET_DIR, "pids", "ptyDaemon.pid");

const sessions = new Map();
const clients = new Set();

const MAX_BUFFER_SIZE = 2 * 1024 * 1024;
const JOIN_REPLAY_SIZE = 256 * 1024;
const HISTORY_CHUNK_SIZE = 256 * 1024;
const MAX_LOG_SIZE = 5 * 1024 * 1024;

// Buffer storage = Buffer[] (byte-accurate) to keep total/have consistent across multibyte/ANSI.
const RESTORE_MODES = ["1049", "1047", "1000", "1002", "1003", "1006", "1015", "1005"];
const DEC_PRIVATE_RE = /\x1b\[\?([0-9;]+)([hl])/g;

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

const LOG_DIR = path.join(SOCKET_DIR, "logs");
const LOG_PATH = path.join(LOG_DIR, "daemon.log");
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function checkLogSize() {
  try {
    if (fs.existsSync(LOG_PATH)) {
      const stats = fs.statSync(LOG_PATH);
      if (stats.size > MAX_LOG_SIZE) {
        const content = fs.readFileSync(LOG_PATH, "utf8");
        const truncated = content.slice(-1024 * 1024);
        fs.writeFileSync(LOG_PATH, truncated);
      }
    }
  } catch (e) {
  }
}

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
  }

  console.error(logLine.trim());
}

function getDefaultCwd() {
  if (process.env.CODESPACES === "true") {
    return process.env.CODESPACE_VSCODE_FOLDER || "/workspaces";
  }
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function buildShellEnv(shellPath) {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8"
  };
  // Don't leak agent internals (PORT, NODE_ENV) into user shells.
  delete env.PORT;
  delete env.NODE_ENV;

  const isZsh = shellPath.includes("zsh");
  const isBash = shellPath.includes("bash");

  let zdotDir = null;
  if (isZsh) {
    // zsh ignores a bare env hook; write a real .zshrc into a temp ZDOTDIR so precmd fires.
    zdotDir = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-zsh-"));
    const tmpZshrc = path.join(zdotDir, ".zshrc");
    const home = env.HOME || os.homedir();
    // Temp ZDOTDIR injected for OSC 7; source HOME login files skipped by zsh.
    let body = "";
    body += `[ -f "${home}/.zprofile" ] && source "${home}/.zprofile"\n`;
    body += `[ -f "${home}/.zshrc" ] && source "${home}/.zshrc"\n`;
    body += `[ -f "${home}/.zlogin" ] && source "${home}/.zlogin"\n`;
    // Append OSC 7 to precmd_functions so a user-defined precmd in .zshrc still runs.
    body += "NineRemoteOsc7() { print -Pn \"\\e]7;file://%m\${PWD}\\e\\\\\" }\n";
    body += "precmd_functions+=( NineRemoteOsc7 )\n";
    fs.writeFileSync(tmpZshrc, body);
    env.ZDOTDIR = zdotDir;
  } else if (isBash) {
    const existingPrompt = env.PROMPT_COMMAND || "";
    env.PROMPT_COMMAND = `printf "\\e]7;file://%s\\a" "\${HOSTNAME}\${PWD}"${existingPrompt ? `; ${existingPrompt}` : ""}`;
  }

  // cmd.exe: OSC 7 via PROMPT env var.
  if (/cmd\.exe$/i.test(shellPath)) {
    env.PROMPT = `$E]7;file://${process.env.COMPUTERNAME || ""}/$P$E\\$G$S`;
  }

  return { env, zdotDir };
}

function broadcast(message) {
  const data = JSON.stringify(message) + "\n";
  for (const client of clients) {
    try {
      client.write(data);
    } catch (e) {
    }
  }
}

function send(client, message) {
  try {
    client.write(JSON.stringify(message) + "\n");
  } catch (e) {
  }
}

// Managed child processes: daemon owns the process, agent handles parsing/protocol.
const procs = new Map();
// procEpoch identifies process incarnation so stale exits are ignored.
let procEpoch = 0;
const PROC_BUFFER_SIZE = 512 * 1024;
// Bound max stream line length before flushing as-is.
const PROC_MAX_LINE = 256 * 1024;
const PROC_KILL_GRACE_MS = 3000;

function procLinesSince(proc, from = 0) {
  const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
  const out = [];
  for (const l of proc.lines) {
    if (l.n > f) out.push({ n: l.n, enc: "b64", data: l.data.toString("base64") });
  }
  return out;
}

function createProc(procId, { bin, args = [], cwd, env } = {}) {
  if (!procId) return { success: false, error: "Missing procId" };
  if (!bin) return { success: false, error: "Missing bin" };
  const existing = procs.get(procId);
  if (existing && !existing.exited) return { success: false, error: "Process already running" };

  const child = spawn(bin, args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : getDefaultCwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(env || {}) }
  });

  const proc = {
    id: procId,
    epoch: ++procEpoch,
    child,
    cwd,
    lines: [],
    lineCount: 0,
    bytes: 0,
    exited: false,
    exitCode: null,
    tail: ""
  };
  procs.set(procId, proc);

  const emitLine = (text) => {
    const data = Buffer.from(text, "utf8");
    proc.lineCount++;
    proc.lines.push({ n: proc.lineCount, data });
    proc.bytes += data.length;
    while (proc.bytes > PROC_BUFFER_SIZE && proc.lines.length > 1) {
      proc.bytes -= proc.lines[0].data.length;
      proc.lines.shift();
    }
    broadcast({ type: "procLine", procId, epoch: proc.epoch, n: proc.lineCount, enc: "b64", data: data.toString("base64") });
  };

  const pump = (stream) => {
    stream.on("data", (chunk) => {
      proc.tail += chunk.toString("utf8");
      if (proc.tail.length > PROC_MAX_LINE) {
        emitLine(proc.tail);
        proc.tail = "";
        return;
      }
      const parts = proc.tail.split("\n");
      proc.tail = parts.pop() || "";
      for (const part of parts) emitLine(part);
    });
  };
  pump(child.stdout);
  pump(child.stderr);

  child.on("error", (err) => {
    proc.exited = true;
    broadcast({ type: "procExit", procId, epoch: proc.epoch, code: null, error: err.message });
  });
  child.on("close", (code, signal) => {
    if (proc.tail) { emitLine(proc.tail); proc.tail = ""; }
    proc.exited = true;
    proc.exitCode = code;
    proc.child = null;
    broadcast({ type: "procExit", procId, epoch: proc.epoch, code, signal: signal || null });
  });

  return { success: true, procId, epoch: proc.epoch, pid: child.pid };
}

function attachProc(procId, from = 0) {
  if (typeof from === "object" && from !== null) from = from.from ?? 0;
  from = Number(from) || 0;
  const proc = procs.get(procId);
  if (!proc) return { success: false, error: "Process not found" };
  return {
    success: true,
    alive: !proc.exited,
    epoch: proc.epoch,
    lines: procLinesSince(proc, from),
    total: proc.lineCount,
    oldest: proc.lines[0]?.n ?? proc.lineCount + 1,
    exitCode: proc.exitCode
  };
}

function writeProc(procId, data, enc = "b64") {
  const proc = procs.get(procId);
  if (!proc?.child?.stdin?.writable) return { success: false, error: "Process not writable" };
  proc.child.stdin.write(enc === "b64" ? Buffer.from(data, "base64") : data);
  return { success: true };
}

// Close stdin for non-interactive CLI engines.
function endInputProc(procId) {
  const proc = procs.get(procId);
  if (!proc?.child?.stdin?.writable) return { success: false, error: "Process not writable" };
  try { proc.child.stdin.end(); } catch (e) { return { success: false, error: e.message }; }
  return { success: true };
}

function signalProc(procId, signal = "SIGINT") {
  const proc = procs.get(procId);
  if (!proc?.child) return { success: false, error: "Process not running" };
  try {
    proc.child.kill(signal);
  } catch (e) {
    return { success: false, error: e.message };
  }
  return { success: true };
}

function stopProc(procId) {
  const proc = procs.get(procId);
  if (!proc) return { success: false, error: "Process not found" };
  const child = proc.child;
  if (child) {
    try { child.kill("SIGINT"); } catch {}
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, PROC_KILL_GRACE_MS);
    timer.unref?.();
    child.once("close", () => clearTimeout(timer));
  }
  procs.delete(procId);
  return { success: true };
}

function createSession(sessionId, name, cols = 80, rows = 24, shellId = null, cwd = null) {
  if (sessions.has(sessionId)) {
    return { success: false, error: "Session already exists" };
  }

  const shellConfig = resolveShell(shellId);
  if (!cwd || !fs.existsSync(cwd)) cwd = getDefaultCwd();

  try {
    const { env: shellEnv, zdotDir } = buildShellEnv(shellConfig.path);
    shellEnv.NINE_REMOTE_SESSION_ID = sessionId;

    const ptyProcess = pty.spawn(shellConfig.path, buildShellArgs(shellConfig), {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: shellEnv,
      useConpty: process.platform === "win32"
    });

    // PowerShell OSC 7 prompt is injected via -NoExit -Command arg.
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
      pending: null,
      flushScheduled: false,
      procTimer: null,
      foregroundProcess: getSessionForegroundProcess({ pty: ptyProcess }) || shellConfig.id
    };

    // Coalesce same-tick onData chunks into one output packet via setImmediate.
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

    ptyProcess.onData((data) => {
      session.buffer.push(Buffer.from(data, "utf-8"));
      applyModes(session.modes, data);
      // Track live cwd from OSC 7 escape sequence.
      const osc7 = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)/);
      if (osc7) {
        let next;
        try { next = decodeURIComponent(osc7[1]); } catch { next = osc7[1]; }
        // Win drive paths gain a leading slash from file://host/<drive>:/ — strip it.
        if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(next)) next = next.slice(1);
        if (next && next !== session.cwd) {
          session.cwd = next;
          broadcast({ type: "cwdChange", sessionId, cwd: next });
        }
      }
      const totalSize = bufferTotal(session.buffer);
      if (totalSize > MAX_BUFFER_SIZE) {
        session.buffer = [takeBufferTail(session.buffer, MAX_BUFFER_SIZE)];
      }

      session.pending = session.pending === null ? data : session.pending + data;
      if (!session.flushScheduled) {
        session.flushScheduled = true;
        setImmediate(flushOutput);
      }

      if (session.procTimer) clearTimeout(session.procTimer);
      session.procTimer = setTimeout(() => {
        session.procTimer = null;
        checkSessionForegroundProcess(session, sessionId);
      }, 250);
    });

    ptyProcess.onExit(() => {
      if (session.procTimer) clearTimeout(session.procTimer);
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

function getSessionForegroundProcess(session) {
  if (!session?.pty) return null;
  try {
    const raw = session.pty.process;
    return raw ? path.basename(raw) : null;
  } catch {
    return null;
  }
}

function checkSessionForegroundProcess(session, sessionId) {
  if (!session?.pty) return;
  const proc = getSessionForegroundProcess(session);
  if (proc && proc !== session.foregroundProcess) {
    const prev = session.foregroundProcess;
    session.foregroundProcess = proc;
    if (prev !== null) {
      broadcast({
        type: "processChange",
        sessionId,
        process: proc,
        prevProcess: prev
      });
    }
  }
}

const kvStore = createKvStore(500);

const router = createRouter({
  deps: { sessions, procs, send, broadcast, DAEMON_VERSION, kv: kvStore },
  send
});

const terminalRoutes = {
  ping: () => ({ version: DAEMON_VERSION }),

  listSessions: () => ({
    sessions: Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      name: s.name,
      createdAt: s.createdAt,
      shellId: s.shellId,
      shellLabel: s.shellLabel,
      cwd: s.cwd,
      foregroundProcess: s.foregroundProcess || getSessionForegroundProcess(s)
    }))
  }),

  createSession: (m) => createSession(
    m.sessionId || `session-${Date.now()}`,
    m.name, m.cols, m.rows, m.shellId, m.cwd
  ),

  joinSession: (m, { send: s }) => {
    const session = sessions.get(m.sessionId);
    if (!session) return { success: false, error: "Session not found" };
    const client = m.client;
    // Restore terminal modes before history replay so alt-screen/mouse modes persist.
    const restore = restoreSeq(session.modes);
    if (restore) {
      s(client, { type: "output", sessionId: m.sessionId, enc: "b64", replay: true, data: Buffer.from(restore).toString("base64") });
    }
    const history = takeBufferTail(session.buffer, JOIN_REPLAY_SIZE);
    if (history && history.length) {
      s(client, { type: "output", sessionId: m.sessionId, enc: "b64", replay: true, data: history.toString("base64") });
    }
    return {
      success: true,
      name: session.name,
      cwd: session.cwd,
      shellId: session.shellId,
      shellLabel: session.shellLabel,
      total: bufferTotal(session.buffer),
      replaySize: history ? history.length : 0
    };
  },

  requestHistory: (m) => {
    // Return chunk of older buffer history preceding what client currently has.
    const session = sessions.get(m.sessionId);
    if (!session) return { success: false, error: "Session not found" };
    const total = bufferTotal(session.buffer);
    const have = Math.max(0, Math.min(m.have || 0, total));
    const remaining = total - have;
    const chunkLen = Math.min(HISTORY_CHUNK_SIZE, remaining);
    const { prefix, extra = 0 } = chunkLen > 0 ? takeBufferRange(session.buffer, have, chunkLen) : { prefix: Buffer.alloc(0), extra: 0 };
    return {
      success: true,
      sessionId: m.sessionId,
      enc: "b64",
      prefix: prefix && prefix.length ? prefix.toString("base64") : "",
      prefixLen: prefix ? prefix.length : 0,
      total,
      remaining: Math.max(0, remaining - chunkLen)
    };
  },

  input: (m) => {
    const session = sessions.get(m.sessionId);
    if (!session?.pty) return {};
    session.pty.write(m.data);
    if (session.procTimer) clearTimeout(session.procTimer);
    session.procTimer = setTimeout(() => {
      session.procTimer = null;
      checkSessionForegroundProcess(session, m.sessionId);
    }, 300);
    return {};
  },

  resize: (m) => {
    const session = sessions.get(m.sessionId);
    if (!session?.pty) return {};
    try {
      session.pty.resize(m.cols, m.rows);
    } catch (e) {
    }
    return {};
  },

  deleteSession: (m, { broadcast: b }) => {
    const session = sessions.get(m.sessionId);
    if (!session) return { success: false, error: "Session not found" };
    if (session.pty) session.pty.kill();
    sessions.delete(m.sessionId);
    b({ type: "sessionClosed", sessionId: m.sessionId });
    return { success: true };
  },

  getCwd: (m) => ({ cwd: sessions.get(m.sessionId)?.cwd || null })
};

const procRoutes = {
  start: (m) => createProc(m.procId, m),
  attach: (m) => attachProc(m.procId, m.from),

  lines: (m) => {
    const p = procs.get(m.procId);
    if (!p) return { success: false, error: "Process not found" };
    return {
      success: true,
      epoch: p.epoch,
      lines: procLinesSince(p, m.from || 0),
      total: p.lineCount,
      oldest: p.lines[0]?.n ?? p.lineCount + 1
    };
  },

  write: (m) => writeProc(m.procId, m.data, m.enc),
  endInput: (m) => endInputProc(m.procId),
  signal: (m) => signalProc(m.procId, m.signal),
  stop: (m) => stopProc(m.procId),

  list: () => ({
    success: true,
    procs: Array.from(procs.values()).map((p) => ({ procId: p.id, alive: !p.exited, total: p.lineCount, cwd: p.cwd }))
  })
};

router.register("terminal", terminalRoutes);
router.register("proc", procRoutes);
router.register("kv", kvRoutes);
// Ensure all promised routes are registered at startup.
router.assertComplete();

function handleMessage(client, message) {
  router.enqueue({ client, message: { ...message, client } });
}

function startDaemon() {
  if (!fs.existsSync(SOCKET_DIR)) {
    try {
      fs.mkdirSync(SOCKET_DIR, { recursive: true });
    } catch (e) {
      logError("Failed to create socket directory", e);
      process.exit(1);
    }
  }

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

  // Write PID for targeted process cleanup.
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  } catch {}

  const cleanupAndExit = () => {
    for (const [, session] of sessions) {
      if (session.procTimer) clearTimeout(session.procTimer);
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }
    for (const [, proc] of procs) {
      try { proc.child?.kill("SIGINT"); } catch {}
    }
    try { server.close(); } catch {}
    if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
      try { fs.unlinkSync(SOCKET_PATH); } catch {}
    }
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };

  process.on("SIGTERM", cleanupAndExit);
  process.on("SIGINT", cleanupAndExit);
}

startDaemon();
