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
import { spawn } from "child_process";
import pty from "node-pty";
import { resolveShell, buildShellArgs, DAEMON_VERSION } from "./constants.js";
import { createRouter } from "./daemonRouter.js";
import { takeBufferTail, takeBufferRange, bufferTotal } from "./bufferSlice.js";

// Socket path. NREMOTE_HOME keeps the daemon's own state inside the root the client
// relocated to — a test daemon must not share snapshots with the live one.
const SOCKET_DIR = process.env.NREMOTE_HOME || path.join(os.homedir(), ".9remote");
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
const JOIN_REPLAY_SIZE = 256 * 1024; // 256KB tail on join — older history fetched on scroll-up
const HISTORY_CHUNK_SIZE = 256 * 1024; // 256KB per scroll-up fetch chunk
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB log file limit

// Buffer storage = Buffer[] (byte-accurate). The web mirror also counts BYTES, so total/have
// stay consistent across CJK/emoji/ANSI output. (Previously string[] + char-length → offset
// drift on multibyte → "load more" loaded wrong/duplicate segments.)
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
  // Don't leak agent internals into user shells: PORT breaks their npm run dev, dev NODE_ENV flips their apps
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
    // zsh login order under $ZDOTDIR: .zshenv → .zshrc → .zlogin (.zprofile sits in $HOME, not ZDOTDIR).
    // We point ZDOTDIR at a temp dir to inject OSC 7, so explicitly source the HOME login files we skipped.
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

  // cmd.exe: OSC 7 via PROMPT env var (native default; setTimeout re-inject in createSession covers AutoRun override).
  if (/cmd\.exe$/i.test(shellPath)) {
    env.PROMPT = `$E]7;file://${process.env.COMPUTERNAME || ""}/$P$E\\$G$S`;
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

// ═══════════════════════════════════════════════════════════════════
// Managed child processes.
//
// A proc is a long-lived CLI the agent drives (a chat engine today). The daemon
// owns it — that is what makes a running turn outlive an agent restart — but it
// knows nothing about what the CLI speaks: lines in, lines out, each numbered so a
// fresh agent can ask for exactly the ones it has not consumed. Parsing prompts,
// history and snapshots all live agent-side, so a change to an engine's protocol
// never touches this file.
// ═══════════════════════════════════════════════════════════════════
const procs = new Map(); // procId -> proc
// Bumped for every process started under a proc id. An exit from a process that has
// already been replaced must not reach the agent as the current one's — a restart
// (mode/model change) kills the old CLI, and its SIGINT lands after the new process is
// already running.
let procEpoch = 0;
// Raw output kept per proc. This is a re-delivery buffer, not a history: the agent
// holds the conversation and only asks for lines it has not read, so it only has to
// cover the gap while no agent is attached. Deliberately smaller than a terminal's
// buffer — that one is the scrollback, this one is a landing strip.
const PROC_BUFFER_SIZE = 512 * 1024;
// A single stream-json line (a big tool result) is large but bounded; past this the
// "line" is flushed as-is rather than accumulating forever.
const PROC_MAX_LINE = 256 * 1024;
const PROC_KILL_GRACE_MS = 3000;

function procLinesSince(proc, from = 0) {
  const out = [];
  for (const l of proc.lines) {
    if (l.n > from) out.push({ n: l.n, enc: "b64", data: l.data.toString("base64") });
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
    // Identifies THIS process: the agent echoes it back on every line and exit it
    // accepts, so output from a torn-down process can never be attributed to its
    // replacement.
    epoch: ++procEpoch,
    child,
    cwd,
    lines: [],
    // 1-based and never reused: the agent stores the last number it consumed, so a
    // number that shifted would make it re-parse or skip a line of the conversation.
    lineCount: 0,
    // Running byte total of `lines`, so trimming is O(1) per line instead of a full
    // re-sum on a path that runs for every line a chat streams.
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

  // stderr is relayed the same way: an engine that fails to start explains itself
  // there, and how to show that is the agent's decision, not ours.
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
    // A last line with no trailing newline still belongs to the conversation.
    if (proc.tail) { emitLine(proc.tail); proc.tail = ""; }
    proc.exited = true;
    proc.exitCode = code;
    proc.child = null;
    broadcast({ type: "procExit", procId, epoch: proc.epoch, code, signal: signal || null });
  });

  return { success: true, procId, epoch: proc.epoch, pid: child.pid };
}

function attachProc(procId, from = 0) {
  const proc = procs.get(procId);
  if (!proc) return { success: false, error: "Process not found" };
  // Attaching never starts anything: the running process IS the session, and a
  // second one would resume the same conversation as a second writer.
  // `oldest` is the lowest line still held: the ring drops its head once it fills, and
  // a reader that asks from further back than this would otherwise be handed a
  // conversation with a silent hole in it.
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

// A turn-per-CLI engine (codex, opencode, agy) is not interactive: an open stdin only
// risks the CLI waiting on a pipe nobody will write to.
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
    // Asked first, killed only if it will not go: a CLI interrupting its own turn
    // is how it gets to flush the transcript.
    try { child.kill("SIGINT"); } catch {}
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, PROC_KILL_GRACE_MS);
    timer.unref?.();
    child.once("close", () => clearTimeout(timer));
  }
  // Gone from the registry at once so a new chat reusing this id can start: the
  // exit event still goes out to whoever was attached.
  procs.delete(procId);
  return { success: true };
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

    const ptyProcess = pty.spawn(shellConfig.path, buildShellArgs(shellConfig), {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: shellEnv,
      useConpty: process.platform === "win32"
    });

    // PowerShell/pwsh: OSC 7 prompt is injected via `-NoExit -Command` arg (see buildShellArgs) —
    // no stdin write, so PSReadLine never echoes the setup line. cmd keeps using PROMPT env.

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
      flushScheduled: false,  // setImmediate flush guard
      procTimer: null,        // debounce timer for process check on output settle
      foregroundProcess: getSessionForegroundProcess({ pty: ptyProcess }) || shellConfig.id
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
        // Win drive paths gain a leading slash from file://host/<drive>:/ — strip it.
        if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(next)) next = next.slice(1);
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

      // Check foreground process when output settles (terminal prompt returns or command exits)
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

// Event-driven foreground process tracking (checked on output settle or input)
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

// ── Route handlers ──
// One entry per thing an agent may ask for, grouped by domain (see daemonRoutes.js for
// the table these must cover). Each is a plain function over the state it needs, so a
// new capability is a new entry here instead of another arm of a switch.

// `client` is the socket that asked; `answer` replies on its requestId. Routes whose
// table entry has no `reply` are fire-and-forget (terminal input/resize) — they call
// neither, and an ack for them would be pure overhead on the typing hot path.
const router = createRouter({
  deps: { sessions, procs, send, broadcast, DAEMON_VERSION },
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
    // Re-emit terminal mode sequences BEFORE history tail — client called reset() on
    // reconnect which wiped alt-buffer/mouse modes; without this, replay lands in the
    // normal buffer and wheel/touch scroll breaks for TUI apps (e.g. opencode).
    // replay:true lets the client ORDER these packets strictly before live output that
    // races between reset() and ack — otherwise a live packet writes into the wrong buffer
    // (alt-screen mode not yet restored) and content is lost/garbled, especially Claude Code.
    const restore = restoreSeq(session.modes);
    if (restore) {
      s(client, { type: "output", sessionId: m.sessionId, enc: "b64", replay: true, data: Buffer.from(restore).toString("base64") });
    }
    // Replay only tail of buffered output to avoid network burst on join
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
      // total = bytes agent still holds; web uses it to know the older-history ceiling
      total: bufferTotal(session.buffer),
      replaySize: history ? history.length : 0
    };
  },

  requestHistory: (m) => {
    // Client scrolled to top → return a CHUNK of bytes just before the bytes it holds.
    // have = bytes the client currently has (its tail). We return the newest older chunk:
    // buffer[total-have-chunkLen .. total-have]. Client splices it before its mirror and
    // replays, then re-requests for the next older chunk. Prefix travels in the ack (not a
    // broadcast output) so only the requesting socket receives it.
    const session = sessions.get(m.sessionId);
    if (!session) return { success: false, error: "Session not found" };
    const total = bufferTotal(session.buffer);
    const have = Math.max(0, Math.min(m.have || 0, total));
    const remaining = total - have;          // bytes older than what client holds
    const chunkLen = Math.min(HISTORY_CHUNK_SIZE, remaining);
    const { prefix, extra = 0 } = chunkLen > 0 ? takeBufferRange(session.buffer, have, chunkLen) : { prefix: Buffer.alloc(0), extra: 0 };
    return {
      success: true,
      sessionId: m.sessionId,
      enc: "b64",
      prefix: prefix && prefix.length ? prefix.toString("base64") : "",
      prefixLen: prefix ? prefix.length : 0,
      total,
      // remaining = older bytes not yet sent. The prefix may extend back `extra` bytes to an ESC
      // boundary; the next fetch covers from there, so remaining shrinks by chunkLen only.
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
      // Ignore resize errors
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

  // Everything the agent missed while it was not attached, by line number. Also the
  // tail-fetch a hydrating agent uses for its first parse.
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
// Every route the table promises must exist here, or an agent waits out a timeout for
// an answer that can never come. Failing at boot is the only cheap way to catch it.
router.assertComplete();

/** Hand a client message to the single-threaded dispatcher. */
function handleMessage(client, message) {
  router.enqueue({ client, message: { ...message, client } });
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
      if (session.procTimer) clearTimeout(session.procTimer);
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }
    // Take the managed CLIs down with us, the same way the PTYs above are. Leaving
    // them running would orphan a process whose pipes the next daemon cannot adopt,
    // and whose conversation the next agent would resume as a second writer.
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

  // Graceful shutdown
  process.on("SIGTERM", cleanupAndExit);
  process.on("SIGINT", cleanupAndExit);
}

// Run daemon
startDaemon();
