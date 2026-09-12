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
import readline from "readline";
import pty from "node-pty";
import { resolveShell, buildShellArgs, DAEMON_VERSION } from "./constants.js";
import { takeBufferTail, takeBufferRange, bufferTotal } from "./bufferSlice.js";
import { aiTailStart, aiHistoryChunk } from "./aiEventSlice.js";
import { recoverFromClaudeTranscript, CLAUDE_SESSION_ID_RE } from "./claudeTranscript.js";
import { stageAttachment, buildAttachedMessage } from "./aiAttachment.js";

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
// AI sessions — same persistence model as PTY sessions: the daemon is
// the single source of truth, the agent is a proxy, clients are viewers.
// ponytail: claude engine only; codex/opencode stay on the in-agent path
// until their stream protocols move here too.
// ═══════════════════════════════════════════════════════════════════
const AI_SESSIONS_DIR = path.join(SOCKET_DIR, "ai-sessions");
const AI_MAX_EVENTS = 5000;
// Tail shipped on connect, mirroring the PTY JOIN_REPLAY_SIZE — the scroll-up fetch
// pulls the same size per chunk. Measured on a real conversation: 6.9 MB of events for
// one long chat, enough to stall a phone on F5.
const AI_REPLAY_BYTES = 128 * 1024;
// Measured on a streaming turn: ~53 events/s, 48 B/event, so a 500ms debounce
// keeps only ~37% of the stream across an unclean death (SIGKILL / power loss;
// the agent's own restart path uses SIGTERM and flushes synchronously). 150ms
// holds ~85% for ~130 KB/s of writes, and turn boundaries flush immediately.
const AI_PERSIST_DEBOUNCE_MS = 150;
// Tool results (a Read of a huge log, a verbose Bash) are re-serialized into the
// snapshot on every debounce tick and replayed to every joiner. Cap what we keep.
const AI_MAX_TOOL_OUTPUT = 64 * 1024;
const aiSessions = new Map(); // sessionId -> session object
const aiPersistTimers = new Map();

try { if (!fs.existsSync(AI_SESSIONS_DIR)) fs.mkdirSync(AI_SESSIONS_DIR, { recursive: true }); } catch {}

function aiSnapshotFile(sessionId) {
  // sessionId comes from the agent over the local socket; sanitize for a filename anyway
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(AI_SESSIONS_DIR, `${safe}.json`);
}

// Async write — a sync one on the streaming hot path would stall the daemon's
// PTY flush (setImmediate) and make terminals stutter.
function persistAiSessionNow(sessionId) {
  const s = aiSessions.get(sessionId);
  if (!s) return;
  if (s.persisting) { s.persistAgain = true; return; }
  s.persisting = true;
  const payload = JSON.stringify({
    engine: s.engine,
    cwd: s.cwd,
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    cliSessionId: s.cliSessionId,
    createdAt: s.createdAt,
    events: s.events
  });
  fs.writeFile(aiSnapshotFile(sessionId), payload, (e) => {
    s.persisting = false;
    if (e) logError(`Failed to persist AI session ${sessionId}`, e);
    const current = aiSessions.get(sessionId);
    // Destroyed while this write was in flight: it just put the file back, and
    // the next daemon would resurrect a session with no terminal behind it.
    if (!current) {
      try { fs.unlink(aiSnapshotFile(sessionId), () => {}); } catch {}
      return;
    }
    // A different session now owns this id — its own persist owns this file, so
    // leave it alone rather than unlinking or writing over it with stale events.
    if (current !== s) return;
    if (s.persistAgain) { s.persistAgain = false; persistAiSessionNow(sessionId); }
  });
}

function schedulePersistAiSession(sessionId) {
  if (aiPersistTimers.has(sessionId)) return;
  aiPersistTimers.set(sessionId, setTimeout(() => {
    aiPersistTimers.delete(sessionId);
    persistAiSessionNow(sessionId);
  }, AI_PERSIST_DEBOUNCE_MS));
}

// Turn boundaries (and user input) are the points worth paying a write for: a
// crash right after them leaves a whole exchange intact, not a half-stream.
function flushAiSession(sessionId) {
  const timer = aiPersistTimers.get(sessionId);
  if (timer) { clearTimeout(timer); aiPersistTimers.delete(sessionId); }
  persistAiSessionNow(sessionId);
}

function loadAiSnapshot(sessionId) {
  try {
    const raw = fs.readFileSync(aiSnapshotFile(sessionId), "utf8");
    const snap = JSON.parse(raw);
    if (!snap || snap.engine !== "claude" || !Array.isArray(snap.events)) return null;
    snap.events = compactAiEvents(snap.events);
    return snap;
  } catch {
    return null;
  }
}

// Compact successive delta/thinking stream slices in s.events into consolidated messages.
// Keeps the array size tiny (<100 events per session) while preserving 100% of text and seq watermarks.
function compactAiEvents(events) {
  if (!Array.isArray(events) || events.length <= 1) return events;
  const compacted = [];
  for (const ev of events) {
    const last = compacted[compacted.length - 1];
    if (last && last.event === ev.event && (ev.event === "delta" || ev.event === "thinking")) {
      last.data = { text: (last.data?.text || "") + (ev.data?.text || "") };
      last.seq = ev.seq;
    } else {
      compacted.push({ ...ev });
    }
  }
  return compacted;
}

// Recover complete conversation history directly from Claude CLI's own .jsonl transcript log.
// seq stamps every event (live AND replayed) so a hydrating client can drop the
// live events it already folded in from the replay. Without it, a prompt sent in
// the same tick as ai:create reaches the browser before the create ack resolves,
// and the ack's clear+replay wipes the message that just arrived.
function broadcastAiEvent(sessionId, event, data, seq) {
  broadcast({ type: "aiEvent", sessionId, event, data, seq });
}

// Truncate tool output before it enters the log: the snapshot is re-serialized
// whole on every debounce tick and replayed to every joining client.
function capToolOutput(data) {
  if (!data) return data;
  const cut = (v) => (typeof v === "string" && v.length > AI_MAX_TOOL_OUTPUT
    ? `${v.slice(0, AI_MAX_TOOL_OUTPUT)}\n… [truncated]`
    : v);
  return { ...data, output: cut(data.output), error: cut(data.error) };
}

// Record + broadcast one normalized event; clients replay these through the
// same reducers they use for live events, so history and live share one shape.
function aiEmit(s, event, data) {
  if (event === "tool_result") data = capToolOutput(data);
  const seq = s.nextSeq++;
  s.events.push({ seq, event, data });
  if (s.events.length > AI_MAX_EVENTS) s.events.splice(0, s.events.length - AI_MAX_EVENTS);
  broadcastAiEvent(s.id, event, data, seq);
  schedulePersistAiSession(s.id);
}

function aiExtendedEnv() {
  const home = os.homedir();
  const extraPaths = process.platform === "win32" ? [
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, ".cargo", "bin"),
  ] : [
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];
  const envPath = (process.env.PATH || "").split(path.delimiter);
  return { ...process.env, PATH: Array.from(new Set([...extraPaths, ...envPath])).join(path.delimiter) };
}

function createAiSession(sessionId, { engine, cwd, options = {} }) {
  if (!sessionId || engine !== "claude") {
    return { success: false, error: engine !== "claude" ? `Unsupported AI engine in daemon: ${engine}` : "Missing sessionId" };
  }
  // A session already live here is reused as-is. A client that reports a different
  // cwd (a stale pane, a moved workspace) must NOT be able to tear down a running
  // conversation — only the explicit aiDestroy path does that.
  if (aiSessions.has(sessionId)) {
    return { success: true, session: aiSessions.get(sessionId) };
  }

  let snap = loadAiSnapshot(sessionId);
  const resolvedCwd = cwd || snap?.cwd || getDefaultCwd();
  let cliSessionId = options.cliSessionId || snap?.cliSessionId || "";

  // If snap events are missing or truncated (fewer user messages) but we have a claude transcript,
  // recover the full history directly from Claude's own jsonl log.
  const snapUserCount = (snap?.events || []).filter((e) => e.event === "user_message").length;
  if ((!snap || snapUserCount <= 1) && cliSessionId) {
    const recovered = recoverFromClaudeTranscript(resolvedCwd, cliSessionId);
    const recoveredUserCount = (recovered || []).filter((e) => e.event === "user_message").length;
    if (recovered && recoveredUserCount > snapUserCount) {
      snap = {
        ...(snap || {}),
        engine: "claude",
        cwd: resolvedCwd,
        cliSessionId,
        events: recovered
      };
    }
  }

  const s = {
    id: sessionId,
    engine: "claude",
    cwd: resolvedCwd,
    proc: null,
    rl: null,
    events: snap ? [...snap.events] : [],
    // Continues past the loaded log so replayed seqs stay unique per session
    nextSeq: (snap?.events?.reduce((max, e) => Math.max(max, e.seq || 0), 0) || 0) + 1,
    isTurnRunning: false,
    permissionMode: options.mode || snap?.permissionMode || "default",
    model: options.model || snap?.model || "",
    // Reasoning effort (--effort); empty means the CLI default.
    effort: options.effort || snap?.effort || "",
    cliSessionId,
    metadata: { model: "", skills: [], slashCommands: [] },
    stats: { totalCost: 0, inputTokens: 0, outputTokens: 0 },
    pendingRequests: new Map(),
    turnStreamedText: "",
    createdAt: snap?.createdAt || Date.now()
  };
  aiSessions.set(sessionId, s);
  spawnClaude(s);
  return { success: true, session: s };
}

function destroyAiSession(sessionId) {
  const s = aiSessions.get(sessionId);
  if (!s) return false;
  const timer = aiPersistTimers.get(sessionId);
  if (timer) { clearTimeout(timer); aiPersistTimers.delete(sessionId); }
  try { s.proc?.kill("SIGINT"); } catch {}
  try { fs.unlinkSync(aiSnapshotFile(sessionId)); } catch {}
  aiSessions.delete(sessionId);
  return true;
}

function spawnClaude(s) {
  try { s.proc?.kill("SIGINT"); } catch {}
  try { s.rl?.close(); } catch {}
  s.proc = null;
  s.rl = null;
  s.isTurnRunning = false;
  s.pendingRequests.clear();
  s.turnStreamedText = "";
  let initializedThisSpawn = false;
  // stderr is where a failed CLI start explains itself (bad auth, bad config) —
  // keep the tail so a silent death can be reported instead of just going quiet.
  let stderrTail = "";

  const args = [
    "-p",
    "--verbose",
    "--permission-prompt-tool", "stdio",
    "--permission-mode", s.permissionMode,
    "--input-format=stream-json",
    "--output-format=stream-json",
    "--include-partial-messages",
  ];
  if (s.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else args.push("--allow-dangerously-skip-permissions");
  if (s.model) args.push("--model", s.model);
  if (s.effort) args.push("--effort", s.effort);
  // Resume the CLI's own conversation after a daemon/agent restart
  if (s.cliSessionId) args.push("--resume", s.cliSessionId);

  const proc = spawn("claude", args, {
    cwd: s.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: aiExtendedEnv()
  });
  s.proc = proc;

  // Handlers bind to THIS process, and stand down the moment a newer one replaces
  // it. spawnClaude can be re-entered from inside these very handlers (a mid-turn
  // mode change restarts on turn_complete), and without the guard the outgoing
  // process's close would null out s.proc — orphaning the fresh one's state.
  const isCurrent = () => s.proc === proc;

  s.rl = readline.createInterface({ input: proc.stdout });
  s.rl.on("line", (line) => {
    if (!isCurrent() || !line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "system" && parsed.subtype === "init") initializedThisSpawn = true;
      handleClaudeLine(s, parsed);
    } catch {
      aiEmit(s, "ansi", { chunk: line + "\r\n" });
    }
  });
  proc.stderr?.on("data", (chunk) => {
    if (!isCurrent()) return;
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-2000);
    aiEmit(s, "ansi", { chunk: text });
  });
  proc.on("error", (err) => {
    if (!isCurrent()) return;
    s.proc = null;
    aiEmit(s, "error", { message: err.message });
  });
  proc.on("close", (code) => {
    if (!isCurrent()) return;
    s.proc = null;
    s.rl = null;
    // The CLI does NOT emit `init` until the first prompt arrives, so a process
    // that exits before init proves nothing about the resume id — it may simply
    // never have been used. Only a non-zero exit is evidence the CLI refused the
    // id (verified: bad --resume exits 1 with "No conversation found"). Treating
    // every pre-init exit as a bad id would discard a perfectly good conversation.
    if (s.cliSessionId && !initializedThisSpawn && code !== 0) {
      s.cliSessionId = "";
      aiEmit(s, "ansi", { chunk: "\r\n[9remote] Không resume được phiên cũ — bắt đầu phiên mới.\r\n" });
    }
    if (s.isTurnRunning) {
      s.isTurnRunning = false;
      aiEmit(s, "stopped", {});
    } else if (!initializedThisSpawn && code !== 0) {
      // Died before init while idle: the chat would show nothing at all, so
      // surface what the CLI said on stderr.
      const why = stderrTail.trim() || "claude CLI exited before starting";
      aiEmit(s, "error", { message: why.slice(-600) });
    }
  });
}

// Mirror of the agent-side claudeAdapter.handleMessage, emitting normalized events
function handleClaudeLine(s, data) {
  if (data.type === "system" && data.subtype === "init") {
    s.cliSessionId = data.session_id || s.cliSessionId;
    s.metadata = {
      sessionId: data.session_id || "",
      model: data.model || "",
      tools: data.tools || [],
      skills: data.skills || [],
      slashCommands: data.slash_commands || [],
    };
    const snapUserCount = (s.events || []).filter((e) => e.event === "user_message").length;
    if (snapUserCount <= 1 && s.cliSessionId) {
      const recovered = recoverFromClaudeTranscript(s.cwd, s.cliSessionId);
      const recoveredUserCount = (recovered || []).filter((e) => e.event === "user_message").length;
      if (recovered && recoveredUserCount > snapUserCount) {
        s.events = recovered;
        s.nextSeq = recovered.reduce((max, e) => Math.max(max, e.seq || 0), 0) + 1;
      }
    }
    aiEmit(s, "init", s.metadata);
    return;
  }

  if (data.type === "stream_event") {
    const event = data.event;
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const text = event.delta.text || "";
      s.turnStreamedText += text;
      aiEmit(s, "delta", { text });
    } else if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
      aiEmit(s, "thinking", { text: event.delta.thinking });
    }
    return;
  }

  if (data.type === "control_request") {
    const { request_id, request = {} } = data;
    const toolName = request.tool_name || "";
    const toolInput = request.input || request.tool_input || {};
    s.pendingRequests.set(request_id, { toolName, input: toolInput });
    aiEmit(s, "permission_request", {
      requestId: request_id,
      tool: toolName,
      input: toolInput,
      type: request.subtype || "permission"
    });
    return;
  }

  if (data.type === "result") {
    s.isTurnRunning = false;
    if (data.total_cost_usd) s.stats.totalCost += Number(data.total_cost_usd) || 0;
    // Slash-command answers (/cost, /compact...) arrive only here — emit as text
    if (!s.turnStreamedText && typeof data.result === "string" && data.result.trim()) {
      aiEmit(s, "delta", { text: data.result });
    }
    s.turnStreamedText = "";
    aiEmit(s, "turn_complete", { stats: { ...s.stats }, result: data.result });
    s.events = compactAiEvents(s.events);
    flushAiSession(s.id);
    // A mode/model change made mid-turn applies now that the process is idle
    if (s.restartPending) {
      s.restartPending = false;
      spawnClaude(s);
    }
    return;
  }

  if (data.type === "assistant" && data.message) {
    const msg = data.message;
    if (msg.usage) {
      s.stats.inputTokens += msg.usage.input_tokens || 0;
      s.stats.outputTokens += msg.usage.output_tokens || 0;
    }
    for (const item of msg.content || []) {
      if (item.type === "tool_use") {
        aiEmit(s, "tool_start", { id: item.id, name: item.name, input: item.input });
      } else if (item.type === "text" && item.text) {
        // Fallback only if text was not streamed already
        if (!s.turnStreamedText) {
          s.turnStreamedText = item.text;
          aiEmit(s, "delta", { text: item.text });
        } else if (item.text.length > s.turnStreamedText.length && item.text.startsWith(s.turnStreamedText)) {
          const remaining = item.text.slice(s.turnStreamedText.length);
          s.turnStreamedText = item.text;
          aiEmit(s, "delta", { text: remaining });
        }
      }
    }
    return;
  }

  if (data.type === "user" && data.message) {
    for (const item of data.message.content || []) {
      if (item.type === "tool_result") {
        const isError = Boolean(item.is_error);
        const output = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
        aiEmit(s, "tool_result", {
          id: item.tool_use_id,
          error: isError ? output : "",
          output: !isError ? output : "",
          status: isError ? "error" : "done"
        });
      }
    }
  }
}

function aiPublicState(s) {
  const from = aiTailStart(s.events, AI_REPLAY_BYTES);
  return {
    sessionId: s.id,
    engine: s.engine,
    cwd: s.cwd,
    // Only the tail ships on connect — a long conversation is MBs, and the browser
    // re-renders the windowed list anyway. The rest arrives on scroll-up (aiHistory).
    events: from > 0 ? s.events.slice(from) : s.events,
    hasMore: from > 0,
    // Highest seq included in `events` — the hydrating client ignores any live
    // event at or below it, so nothing is applied twice or lost to the reset.
    seq: s.nextSeq - 1,
    isTurnRunning: s.isTurnRunning,
    // The daemon spawns the CLI with this mode, so it is the only authority on
    // it. Without it in the snapshot a second client (or a reload) would show
    // "Default" while Claude actually runs in bypass/plan.
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    metadata: s.metadata,
    // The CLI's own conversation id. The host records it from here, so a terminal
    // switched into the chat UI knows which conversation the pane is showing even
    // before the CLI's init event lands — and can re-record it after a restart.
    cliSessionId: s.cliSessionId,
    cliAlive: Boolean(s.proc)
  };
}

function aiPrompt(sessionId, message, cwd = null, attachments = null) {
  // A prompt can race the create that precedes it (or arrive with no pane state
  // at all) — auto-create so the message is never dropped. cwd rides along so
  // the raced session still lands in the right directory, not $HOME.
  let s = aiSessions.get(sessionId);
  if (!s) {
    const created = createAiSession(sessionId, { engine: "claude", cwd, options: {} });
    if (!created.success) return { success: false, error: created.error };
    s = created.session;
  }
  // Attachments alone are a valid prompt (an image needs no caption). Stage them
  // before the guard so a bare image is not rejected as "missing message".
  let staged = null;
  if (Array.isArray(attachments) && attachments.length > 0) {
    try {
      staged = attachments.map(stageAttachment);
    } catch (err) {
      return { success: false, error: `Attachment failed: ${err.message}` };
    }
  }
  if (typeof message !== "string") message = "";
  if (!message.trim() && !staged) return { success: false, error: "Missing message" };
  if (message === "/clear") {
    s.events = [];
    persistAiSessionNow(sessionId);
    broadcastAiEvent(sessionId, "conversation_reset", {});
    return { success: true };
  }
  // A process on its way out can still report stdin as writable, and writing there
  // loses the message — so respawn whenever the child is already gone or closing.
  if (!s.proc || s.proc.exitCode !== null || !s.proc.stdin.writable) spawnClaude(s);
  const proc = s.proc;
  if (!proc?.stdin.writable) return { success: false, error: "claude CLI is not accepting input" };
  s.isTurnRunning = true;
  s.turnStreamedText = "";
  // The daemon echoes the user message to every client (single source of truth)
  aiEmit(s, "user_message", { text: message });
  try {
    // An attached message carries image blocks and/or file paths; plain text falls
    // back to the ordinary shape.
    const payload = buildAttachedMessage(message, staged) || {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: message }] }
    };
    proc.stdin.write(JSON.stringify(payload) + "\n");
    // The user's own message is the other thing worth a synchronous write: if the
    // daemon dies before the reply lands, at least what was asked is on disk.
    flushAiSession(sessionId);
  } catch (err) {
    s.isTurnRunning = false;
    return { success: false, error: err.message };
  }
  return { success: true };
}

// Ask the CLI to abort the current turn. cancel_queued drops anything it had
// already taken in, so Stop means stop. Returns false when the request could not
// be written (dead pipe), letting the caller fall back to a signal.
function sendInterrupt(s) {
  if (!s.proc || !s.proc.stdin.writable) return false;
  try {
    s.proc.stdin.write(JSON.stringify({
      type: "control_request",
      request_id: `int-${s.nextSeq}-${Date.now()}`,
      request: { subtype: "interrupt", cancel_queued: true }
    }) + "\n");
    return true;
  } catch {
    return false;
  }
}

function aiControlResponse(s, requestId, response, resolvedBy = "") {
  if (!s.proc || !s.proc.stdin.writable) return false;
  s.pendingRequests.delete(requestId);
  s.proc.stdin.write(JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response }
  }) + "\n");
  // Every other client watching this session must drop its permission card too —
  // otherwise the second surface keeps showing a gate nobody is waiting on.
  aiEmit(s, "permission_resolved", { requestId, behavior: response.behavior, resolvedBy });
  return true;
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
        cwd: s.cwd,
        foregroundProcess: s.foregroundProcess || getSessionForegroundProcess(s)
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
      // replay:true lets the client ORDER these packets strictly before live output that
      // races between reset() and ack — otherwise a live packet writes into the wrong buffer
      // (alt-screen mode not yet restored) and content is lost/garbled, especially Claude Code.
      const restore = restoreSeq(session.modes);
      if (restore) {
        send(client, { type: "output", sessionId, enc: "b64", replay: true, data: Buffer.from(restore).toString("base64") });
      }
      // Replay only tail of buffered output to avoid network burst on join
      const history = takeBufferTail(session.buffer, JOIN_REPLAY_SIZE);
      if (history && history.length) {
        send(client, {
          type: "output",
          sessionId,
          enc: "b64",
          replay: true,
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
      const { prefix, extra = 0 } = chunkLen > 0 ? takeBufferRange(hSession.buffer, have, chunkLen) : { prefix: Buffer.alloc(0), extra: 0 };
      send(client, {
        type: "historyResult",
        success: true,
        sessionId,
        enc: "b64",
        prefix: prefix && prefix.length ? prefix.toString("base64") : "",
        prefixLen: prefix ? prefix.length : 0,
        total,
        // remaining = older bytes not yet sent. The prefix may extend back `extra` bytes to an ESC
        // boundary; the next fetch covers from there, so remaining shrinks by chunkLen only.
        remaining: Math.max(0, remaining - chunkLen),
        requestId: payload.requestId
      });
      break;
    }

    case "input":
      const inputSession = sessions.get(sessionId);
      if (inputSession?.pty) {
        inputSession.pty.write(payload.data);
        if (inputSession.procTimer) clearTimeout(inputSession.procTimer);
        inputSession.procTimer = setTimeout(() => {
          inputSession.procTimer = null;
          checkSessionForegroundProcess(inputSession, sessionId);
        }, 300);
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

    // ── AI sessions (persistent, daemon-owned) ──
    case "createAiSession": {
      const created = createAiSession(sessionId, { engine: payload.engine, cwd: payload.cwd, options: payload.options });
      send(client, {
        type: "aiCreateResult",
        success: created.success,
        error: created.error,
        session: created.session ? aiPublicState(created.session) : null,
        requestId: payload.requestId
      });
      break;
    }

    case "joinAiSession": {
      const aiSession = aiSessions.get(sessionId);
      if (!aiSession) {
        send(client, { type: "aiJoinResult", success: false, error: "AI session not found", requestId: payload.requestId });
        break;
      }
      send(client, { type: "aiJoinResult", success: true, session: aiPublicState(aiSession), requestId: payload.requestId });
      break;
    }

    // Client scrolled to the top of the chat → the chunk of events older than the
    // oldest seq it holds. The client prepends it and replays through the same reducer.
    case "aiHistory": {
      const hSession = aiSessions.get(sessionId);
      if (!hSession) {
        send(client, { type: "aiHistoryResult", success: false, error: "AI session not found", requestId: payload.requestId });
        break;
      }
      const { events, hasMore } = aiHistoryChunk(hSession.events, payload.before, AI_REPLAY_BYTES);
      send(client, { type: "aiHistoryResult", success: true, events, hasMore, requestId: payload.requestId });
      break;
    }

    case "aiPrompt":
      send(client, { type: "aiPromptResult", ...aiPrompt(sessionId, payload.message, payload.cwd, payload.attachments), requestId: payload.requestId });
      break;

    // controlRequestId (Claude's control-request id) is distinct from requestId
    // (the IPC correlation id request() stamps on) — mixing them strands the wait.
    case "aiPermission": {
      const permSession = aiSessions.get(sessionId);
      if (!permSession) {
        send(client, { type: "aiPermissionResult", success: false, error: "AI session not found", requestId: payload.requestId });
        break;
      }
      const pending = permSession.pendingRequests.get(payload.controlRequestId);
      const ok = aiControlResponse(permSession, payload.controlRequestId, payload.behavior === "allow"
        ? { behavior: "allow", updatedInput: pending?.input || {} }
        : { behavior: "deny", message: payload.message || "Permission denied." });
      send(client, { type: "aiPermissionResult", success: ok, requestId: payload.requestId });
      break;
    }

    case "aiQuestion": {
      const qSession = aiSessions.get(sessionId);
      if (!qSession) {
        send(client, { type: "aiQuestionResult", success: false, error: "AI session not found", requestId: payload.requestId });
        break;
      }
      const qPending = qSession.pendingRequests.get(payload.controlRequestId);
      const qOk = aiControlResponse(qSession, payload.controlRequestId, {
        behavior: "allow",
        updatedInput: { questions: qPending?.input?.questions || [], answers: payload.answers || {} }
      });
      send(client, { type: "aiQuestionResult", success: qOk, requestId: payload.requestId });
      break;
    }

    case "aiStop": {
      const stopSession = aiSessions.get(sessionId);
      if (stopSession) {
        // Interrupt the TURN, not the process: a control_request keeps the CLI and
        // its conversation alive, so the next prompt resumes the same context.
        // SIGINT would kill it mid-turn — the transcript stays but the live session
        // (and everything queued in it) is gone.
        const sent = sendInterrupt(stopSession);
        stopSession.isTurnRunning = false;
        aiEmit(stopSession, "stopped", {});
        stopSession.events = compactAiEvents(stopSession.events);
        flushAiSession(stopSession.id);
        // Fall back to a signal only if the interrupt could not be delivered
        if (!sent) { try { stopSession.proc?.kill("SIGINT"); } catch {} }
      }
      send(client, { type: "aiStopResult", success: Boolean(stopSession), requestId: payload.requestId });
      break;
    }

    case "aiOptions": {
      const optSession = aiSessions.get(sessionId);
      if (optSession) {
        const { mode, model, resume, effort } = payload.options || {};
        let changed = false;
        let resumed = false;
        if (model && model !== optSession.model) { optSession.model = model; optSession.restartPending = true; changed = true; }
        if (mode && mode !== optSession.permissionMode) { optSession.permissionMode = mode; optSession.restartPending = true; changed = true; }
        // Effort is a spawn-time flag too, so a change needs the same restart.
        if (effort && effort !== optSession.effort) { optSession.effort = effort; optSession.restartPending = true; changed = true; }
        // Resume a past conversation: rebind the CLI to that session id, then restart.
        // The id comes from a client, so it is validated here — it is passed to the CLI
        // as an argv value and used to build a transcript path.
        if (resume && resume !== optSession.cliSessionId) {
          if (!CLAUDE_SESSION_ID_RE.test(resume)) {
            send(client, { type: "aiOptionsResult", success: false, error: "Invalid resume id", requestId: payload.requestId });
            break;
          }
          optSession.cliSessionId = resume;
          optSession.restartPending = true;
          changed = true;
          resumed = true;
        }
        // Mid-turn: remember it and restart when the turn ends instead of dropping
        // the change (a mode switch the user just made must not silently no-op).
        if (optSession.restartPending && !optSession.isTurnRunning) {
          optSession.restartPending = false;
          spawnClaude(optSession);
        }
        if (resumed) {
          // The client's view still holds the PREVIOUS conversation. Replace the log
          // with the resumed transcript, then replay it, or the pane would show one
          // conversation while the CLI continues another.
          const recovered = recoverFromClaudeTranscript(optSession.cwd, resume);
          if (recovered) {
            optSession.events = recovered;
            optSession.nextSeq = recovered.reduce((max, e) => Math.max(max, e.seq || 0), 0) + 1;
            persistAiSessionNow(sessionId);
            // Only the tail is replayed — the rest is fetched on scroll-up. The reset
            // event states where the window begins and whether anything precedes it, or
            // the client would guess the wrong seq and lock its scroll-up shut.
            const keepFrom = aiTailStart(recovered, AI_REPLAY_BYTES);
            broadcastAiEvent(sessionId, "conversation_reset", {
              hasMore: keepFrom > 0,
              fromSeq: recovered[keepFrom]?.seq ?? 0
            });
            for (const ev of recovered.slice(keepFrom)) broadcastAiEvent(sessionId, ev.event, ev.data, ev.seq);
          }
        }
        if (changed) {
          // Other surfaces show this mode too — broadcast so they do not keep
          // displaying a mode the CLI is no longer running in.
          aiEmit(optSession, "options_changed", {
            permissionMode: optSession.permissionMode,
            model: optSession.model
          });
          schedulePersistAiSession(sessionId);
        }
      }
      send(client, { type: "aiOptionsResult", success: Boolean(optSession), requestId: payload.requestId });
      break;
    }

    case "aiDestroy":
      destroyAiSession(sessionId);
      send(client, { type: "aiDestroyResult", success: true, requestId: payload.requestId });
      break;

    case "listAiSessions":
      send(client, {
        type: "aiSessionList",
        sessions: Array.from(aiSessions.values()).map((s) => ({
          id: s.id, engine: s.engine, cwd: s.cwd, createdAt: s.createdAt
        })),
        requestId: payload.requestId
      });
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
      if (session.procTimer) clearTimeout(session.procTimer);
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }
    // Flush pending AI snapshots synchronously — the debounced async write would
    // not land before exit, losing the last turns of a conversation.
    for (const [id, s] of aiSessions) {
      const timer = aiPersistTimers.get(id);
      if (timer) { clearTimeout(timer); aiPersistTimers.delete(id); }
      // Take the claude child down with us, the same way the PTYs above are taken
      // down. Exiting without this orphans it: its pipes close but the process
      // lingers, and the next daemon resumes the same conversation as a second
      // writer to one transcript.
      try { s.proc?.kill("SIGINT"); } catch {}
      try { s.rl?.close(); } catch {}
      try {
        fs.writeFileSync(aiSnapshotFile(id), JSON.stringify({
          engine: s.engine,
          cwd: s.cwd,
          permissionMode: s.permissionMode,
          model: s.model,
          effort: s.effort,
          cliSessionId: s.cliSessionId,
          createdAt: s.createdAt,
          events: s.events
        }));
      } catch {}
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
