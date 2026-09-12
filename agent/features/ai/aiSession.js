// Represents a single active AI session (Claude, Codex, or OpenCode)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { AI_ENGINES, AI_TURN_IDLE_TIMEOUT_MS, AI_DOCTOR_TIMEOUT_MS } from "./constants.js";
import { getExtendedEnv } from "./adapters/env.js";
import { recoverFromTranscript } from "./transcript.js";
import { ClaudeAdapter } from "./adapters/claudeAdapter.js";
import { CodexAdapter } from "./adapters/codexAdapter.js";
import { OpenCodeAdapter } from "./adapters/opencodeAdapter.js";
import { AntigravityAdapter } from "./adapters/antigravityAdapter.js";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;
const stripAnsi = (text) => String(text || "").replace(ANSI_RE, "");

// Engine → the CLI's own health command. Read from each adapter's static spec so
// the command name lives next to the adapter that owns it, and asking for it
// never spawns a session. A Map (not a plain object) so an engine id like
// "constructor" cannot resolve to an inherited Object.prototype member.
const DOCTOR_SPECS = new Map(
  Object.entries({
    [AI_ENGINES.CLAUDE]: ClaudeAdapter,
    [AI_ENGINES.CODEX]: CodexAdapter,
    [AI_ENGINES.OPENCODE]: OpenCodeAdapter,
    [AI_ENGINES.ANTIGRAVITY]: AntigravityAdapter
  }).map(([engine, Adapter]) => [engine, Adapter.doctorSpec?.() || null])
);

/**
 * Run an engine CLI's own health command on the host and return its output.
 * Spawns only the doctor command itself — never an AI session.
 */
export async function runEngineDoctor(engine, cwd, mock = false) {
  if (mock) return { ok: true, output: "Mock doctor: environment OK.", version: "mock" };
  const spec = DOCTOR_SPECS.get(engine);
  if (!spec?.command) return { ok: false, error: `No doctor command for engine: ${engine}` };
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args || [], { cwd, env: getExtendedEnv() });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ ok: false, error: `${spec.command} doctor timed out.` });
    }, AI_DOCTOR_TIMEOUT_MS);
    child.stdout?.on("data", (c) => { out += c.toString(); });
    child.stderr?.on("data", (c) => { err += c.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Doctor output often carries ANSI colour codes — this text is rendered as
      // plain text in the UI, so strip them.
      const clean = stripAnsi(out || err);
      if (code !== 0 && !clean) return resolve({ ok: false, error: `${spec.command} doctor exited with code ${code}` });
      resolve({ ok: true, output: clean, version: "" });
    });
  });
}

const AI_SESSIONS_DIR = path.join(os.homedir(), ".9remote", "ai-sessions");
try { if (!fs.existsSync(AI_SESSIONS_DIR)) fs.mkdirSync(AI_SESSIONS_DIR, { recursive: true }); } catch {}

// Claude's persistence is owned by the PTY daemon, which writes `<sessionId>.json` in
// this same directory. The in-agent engines get an engine-prefixed filename so the two
// can never write over each other.
const ownsSnapshot = (engine) => engine !== AI_ENGINES.CLAUDE;

function aiSnapshotFile(sessionId, engine) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(AI_SESSIONS_DIR, `${engine}-${safe}.json`);
}

function loadSessionSnapshot(sessionId, engine) {
  try {
    const raw = fs.readFileSync(aiSnapshotFile(sessionId, engine), "utf8");
    const snap = JSON.parse(raw);
    if (!snap || snap.engine !== engine || !Array.isArray(snap.events)) return null;
    return snap;
  } catch {
    return null;
  }
}

// Events that end a turn — the session's own flag must clear on all of them, not just
// the happy path, or a client hydrating after a crash shows a spinner forever.
const TURN_END_EVENTS = new Set(["turn_complete", "stopped", "error", "exit"]);

// A conversation id a client may resume. Thread/session ids are UUID-like; the first
// character may not be "-" (argv would read it as a flag) and no path or whitespace is
// allowed. Anything else is rejected before it can reach the CLI.
const RESUME_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

// Adapter metadata.model defaults when nothing is configured. These are shown in the UI
// but must never be remembered as a model id (see emitNormalized).
const MODEL_LABELS = new Set(["codex default", "opencode default"]);

function compactEvents(events) {
  if (!Array.isArray(events) || events.length <= 1) return events;
  const compacted = [];
  for (const ev of events) {
    const last = compacted[compacted.length - 1];
    if (last && last.event === ev.event && (ev.event === "delta" || ev.event === "thinking")) {
      last.data = { text: (last.data?.text || "") + (ev.data?.text || "") };
      if (ev.seq) last.seq = ev.seq;
    } else {
      compacted.push({ ...ev });
    }
  }
  return compacted;
}

export class AiSession {
  constructor({ id, engine, cwd, options = {}, onEvent }) {
    this.id = id;
    this.engine = engine;
    this.cwd = cwd || process.cwd();
    this.options = options;
    this.onEvent = onEvent;
    this.createdAt = Date.now();
    this.isTurnRunning = false;
    this.lastPrompt = "";
    this.adapter = null;

    const snap = ownsSnapshot(engine) ? loadSessionSnapshot(id, engine) : null;
    this.history = snap ? compactEvents(snap.events) : [];
    this.threadId = snap?.threadId || options.threadId || null;
    this.cliSessionId = snap?.cliSessionId || options.sessionId || null;
    this.model = snap?.model || options.model || "";
    // Restored so a reload keeps the mode the user picked (codex/opencode run a fresh
    // CLI per turn, so the mode has to be re-sent with every prompt).
    this.permissionMode = snap?.permissionMode || options.mode || null;
    // Discovered at connect time by aiSocket; kept so a cleared log can be re-seeded
    this.skills = [];
    this.idleTimer = null;

    if (!options.mock) {
      this.initAdapter();
    }
  }

  initAdapter() {
    // Same guard ptyDaemon uses for a respawned process: handlers bind to the adapter
    // that owns them and stand down once a newer one replaces it. Without this the
    // process killed by /clear still reported its close/stdio events into the session
    // that replaced it — a late turn_complete landed in the freshly cleared log.
    let mine = null;
    const onEvent = (event, data) => {
      if (this.adapter !== mine) return;
      this.emitNormalized(event, data);
    };

    switch (this.engine) {
      case AI_ENGINES.CLAUDE:
        mine = new ClaudeAdapter({ cwd: this.cwd, onEvent });
        this.adapter = mine;
        // Set spawn-time options BEFORE start(): setOptions would restart the CLI,
        // and calling start() afterwards would spawn a second process.
        if (this.options.effort) mine.effort = this.options.effort;
        // The in-agent path (used when the PTY daemon is not connected) must also
        // honour a resumed conversation id, or /resume silently starts a new one.
        mine.start(this.options.mode || "default", this.cliSessionId);
        break;
      case AI_ENGINES.CODEX:
        mine = new CodexAdapter({
          cwd: this.cwd,
          onEvent,
          threadId: this.threadId,
          model: this.model || this.options.model
        });
        this.adapter = mine;
        // Mode is re-sent on every rebuild: the CLI is spawned fresh per turn, and the
        // stored mode is what a reload or a /clear must restore.
        if (this.permissionMode || this.options.model || this.options.effort || this.options.sandbox || this.options.flags) {
          mine.setOptions({ ...this.options, mode: this.permissionMode || this.options.mode });
        }
        break;
      case AI_ENGINES.OPENCODE:
        mine = new OpenCodeAdapter({
          cwd: this.cwd,
          onEvent,
          sessionId: this.cliSessionId,
          model: this.model || this.options.model
        });
        this.adapter = mine;
        if (this.permissionMode || this.options.model || this.options.variant || this.options.flags) {
          mine.setOptions({ ...this.options, mode: this.permissionMode || this.options.mode });
        }
        break;
      case AI_ENGINES.ANTIGRAVITY:
        mine = new AntigravityAdapter({
          cwd: this.cwd,
          onEvent,
          conversationId: this.cliSessionId,
          model: this.model || this.options.model
        });
        this.adapter = mine;
        if (this.permissionMode || this.options.model || this.options.flags) {
          mine.setOptions({ ...this.options, mode: this.permissionMode || this.options.mode });
        }
        break;
      default:
        throw new Error(`Unsupported engine: ${this.engine}`);
    }
  }

  emitNormalized(event, data, record = true) {
    if (event === "init") {
      if (data?.threadId) this.threadId = data.threadId;
      if (data?.sessionId) this.cliSessionId = data.sessionId;
      // Only a real model id may be remembered: this value is handed back to the CLI
      // as `-m` when an adapter is rebuilt (a /clear, a restart). Adapters default
      // their metadata.model to a human label when nothing is configured; sending that
      // as a model id 404s the provider. Configured models always come from setOptions.
      if (data?.model && !MODEL_LABELS.has(data.model)) this.model = data.model;
    }
    // record=false pushes the event to clients without appending to the replay log —
    // used for per-connect metadata that would otherwise accumulate on every F5
    if (record) {
      this.history.push({ event, data, timestamp: Date.now() });
      if (this.history.length > 5000) this.history.shift();
    }
    this.onEvent?.(this.id, event, data);
    if (this.isTurnRunning) this.armIdleWatchdog();

    // Any terminal event releases the turn. Missing `error`/`exit` here left the flag
    // stuck true after a failed spawn, and the ack hands that flag to every client —
    // so the pane came back from an F5 spinning on a process that was already gone.
    if (TURN_END_EVENTS.has(event)) {
      this.isTurnRunning = false;
      this.clearIdleWatchdog();
      this.history = compactEvents(this.history);
      this.saveSnapshot(true);
    }
  }

  // True when this session already has an init in its replay log
  hasRecordedInit() {
    return this.history.some((e) => e.event === "init");
  }

  // Re-armed on every event of a running turn: silence past the window means the CLI is
  // wedged, which would otherwise leave the chat spinning with no reply and no error.
  armIdleWatchdog() {
    this.clearIdleWatchdog();
    if (!ownsSnapshot(this.engine)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.isTurnRunning) return;
      try { this.adapter?.stop(); } catch {}
      this.emitNormalized("error", {
        message: `No response from the ${this.engine} CLI for ${Math.round(AI_TURN_IDLE_TIMEOUT_MS / 1000)}s — the turn was stopped. This usually means the CLI stalled on startup; try again.`
      });
    }, AI_TURN_IDLE_TIMEOUT_MS);
  }

  clearIdleWatchdog() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  saveSnapshot(sync = false) {
    if (!ownsSnapshot(this.engine)) return;
    try {
      const payload = JSON.stringify({
        engine: this.engine,
        cwd: this.cwd,
        threadId: this.threadId,
        cliSessionId: this.cliSessionId,
        model: this.model,
        permissionMode: this.permissionMode,
        createdAt: this.createdAt,
        events: this.history
      });
      if (sync) {
        fs.writeFileSync(aiSnapshotFile(this.id, this.engine), payload);
      } else {
        fs.writeFile(aiSnapshotFile(this.id, this.engine), payload, () => {});
      }
    } catch {}
  }

  sendPrompt(prompt, attachments = null) {
    // Clear is a host-side reset, not a message. Without this the old log survived a
    // Clear and came back on the next F5 — and the literal "/clear" was recorded as a
    // prompt on top of it.
    if (String(prompt).trim() === "/clear") {
      // Drop the CLI conversation too, or the "cleared" chat resumes on the next
      // restart: the adapter holds a live thread/session id and this session's copy of
      // it is written straight into the snapshot. Rebuilding the adapter is what
      // silences the old process — its handlers stand down once this.adapter moves on.
      this.threadId = null;
      this.cliSessionId = null;
      this.history = [];
      this.isTurnRunning = false;
      this.clearIdleWatchdog();
      this.saveSnapshot(true);
      if (!this.options.mock) {
        // Kill before rebuilding — initAdapter replaces the reference, and an adapter
        // dropped without stop() leaves its CLI process running with nothing reading it.
        try { this.adapter?.stop(); } catch {}
        this.initAdapter();
      }
      const init = this.metadata();
      this.history.push({ event: "init", data: init, timestamp: Date.now() });
      this.onEvent?.(this.id, "conversation_reset", {});
      this.onEvent?.(this.id, "init", init);
      this.saveSnapshot(true);
      return;
    }

    this.lastPrompt = prompt;
    this.isTurnRunning = true;
    this.emitNormalized("user_message", { text: prompt });
    if (this.options.mock) {
      this.emitNormalized("delta", { text: `[Mock reply to: ${prompt}]` });
      this.emitNormalized("turn_complete", { stats: {} });
      return;
    }
    this.adapter?.sendPrompt(prompt, attachments);
  }

  // Metadata carried in `init`, restored from disk so a cleared session still names its
  // model and skills before the CLI has had a chance to say anything.
  metadata() {
    return { model: this.model || "", threadId: this.threadId || "", sessionId: this.cliSessionId || "", skills: this.skills || [] };
  }

  resolvePermission(requestId, behavior, message) {
    this.adapter?.resolvePermission?.(requestId, behavior, message);
  }

  resolveQuestion(requestId, answers) {
    this.adapter?.resolveQuestion?.(requestId, answers);
  }

  setOptions(opts) {
    // `resume` is a one-shot action, not a sticky option: keeping it would make every
    // later adapter rebuild (a /clear, a restart) re-bind the thread we just left.
    const { resume: rawResume, ...rest } = opts || {};
    // The resume id arrives from a client and is passed to the CLI as an argv value —
    // an id beginning with "-" would be parsed as a flag (e.g. bypassing the sandbox).
    // Only a plain id is accepted.
    const resume = typeof rawResume === "string" && RESUME_ID_RE.test(rawResume) ? rawResume : null;
    this.options = { ...this.options, ...rest };
    // Remember the mode on the session too — it is what the snapshot stores, so a
    // reload comes back to the mode the user actually chose.
    if (rest?.mode) this.permissionMode = rest.mode;
    // Resuming a past conversation moves the thread/session id this session holds,
    // so a reload keeps talking to the resumed one.
    if (resume) {
      if (this.engine === AI_ENGINES.CLAUDE) this.cliSessionId = resume;
      else if (this.engine === AI_ENGINES.CODEX) this.threadId = resume;
      else if (this.engine === AI_ENGINES.OPENCODE) this.cliSessionId = resume;
      // Antigravity's conversation id lives on cliSessionId too, and its transcript
      // reader is not written yet — the CLI keeps talking to the resumed conversation,
      // but the pane replays nothing.
      else if (this.engine === AI_ENGINES.ANTIGRAVITY) this.cliSessionId = resume;
      // Replace the replay log with the resumed conversation's tail, or the pane would
      // show one conversation while the CLI continues another. The readers pull from
      // each CLI's own store (codex rollouts, opencode db).
      const recovered = recoverFromTranscript(this.engine, this.cwd, resume);
      this.history = recovered || [];
      this.onEvent?.(this.id, "conversation_reset", {});
      if (recovered) {
        // Replayed as ordinary events: clients rebuild the same way they do on a join.
        for (const ev of recovered) this.onEvent?.(this.id, ev.event, ev.data);
      }
    }
    // Forward only the validated id; the adapter must never see an unvalidated value.
    this.adapter?.setOptions?.({ ...opts, resume });
    // effort/mode are snapshot state: a reload or /clear rebuild must restore them.
    if (rest?.mode || rest?.effort || resume) this.saveSnapshot(true);
  }

  // Run the engine CLI's own health command (claude doctor / codex doctor /
  // opencode debug). Resolved from a static spec so no CLI process is spawned to
  // answer it — constructing an adapter would start a real session.
  async runDoctor() {
    return runEngineDoctor(this.engine, this.cwd, this.options.mock);
  }

  stop() {
    this.adapter?.stop();
    this.emitNormalized("stopped", {});
  }

  destroy() {
    this.clearIdleWatchdog();
    this.stop();
    if (!ownsSnapshot(this.engine)) return;
    try { fs.unlinkSync(aiSnapshotFile(this.id, this.engine)); } catch {}
  }
}
