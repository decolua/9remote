// Represents a single active AI session (Claude, Codex, or OpenCode)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AI_ENGINES, AI_TURN_IDLE_TIMEOUT_MS, AI_DOCTOR_TIMEOUT_MS, AI_PERSIST_DEBOUNCE_MS, AI_PERSIST_STREAM_MS, AI_MAX_EVENTS, AI_MAX_TOOL_OUTPUT } from "./constants.js";
import { getExtendedEnv } from "./adapters/env.js";
import { recoverFromTranscript } from "./transcript.js";
import { readThreadGoal } from "./goal.js";
import { ClaudeAdapter } from "./adapters/claudeAdapter.js";
import { DaemonProc } from "./proc/daemonProc.js";
import { replayWindow } from "./aiEventSlice.js";
import { AI_REPLAY_BYTES } from "./constants.js";
import * as daemonClient from "../terminal/ptyDaemonClient.js";
import { CodexAdapter } from "./adapters/codexAdapter.js";
import { OpenCodeAdapter } from "./adapters/opencodeAdapter.js";
import { AntigravityAdapter } from "./adapters/antigravityAdapter.js";
import { attachmentMeta } from "./aiAttachment.js";
import { getLastOutputAt, OUTPUT_LIVE_WINDOW_MS } from "../terminal/statusManager.js";
import { TURN_END_EVENTS } from "./aiStatus.js";
import { PATHS } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("ai");

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;
const stripAnsi = (text) => String(text || "").replace(ANSI_RE, "");

// Engines whose CLI the daemon owns, so a turn outlives an agent restart. The daemon
// holds only the process; the parsing and the conversation log stay here.
//
// Claude spawns once per conversation and its adapter drives that process for its whole
// life. The other three are turn-per-CLI: the adapter still decides when a process is
// born, it just asks the daemon instead of spawning — which is what lets a turn in
// flight be adopted by the agent that comes back.
const MANAGED_ENGINES = new Set([AI_ENGINES.CLAUDE, AI_ENGINES.CODEX, AI_ENGINES.OPENCODE, AI_ENGINES.ANTIGRAVITY]);

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

// Follows the agent's own root (see lib/constants) — never a hardcoded ~/.9remote,
// so a relocated or test instance keeps its conversations to itself.
const AI_SESSIONS_DIR = PATHS.AI_SESSIONS;
try { if (!fs.existsSync(AI_SESSIONS_DIR)) fs.mkdirSync(AI_SESSIONS_DIR, { recursive: true }); } catch {}

// Every engine owns its snapshot here now, daemon-driven or not: the daemon holds
// only the CLI process, so the conversation log is the agent's to write.
// ponytail: snapshots written by the old daemon under `<sessionId>.json` are left
// behind — a chat whose id moved to `<engine>-<id>.json` re-reads its transcript
// instead. Delete the legacy files in a later cleanup, not here.
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

// A sub-agent's tool events, renamed on the wire so the client nests rather than
// appends them. Only these two carry a parentToolUseId today.
const CHILD_EVENTS = { tool_start: "tool_child", tool_result: "tool_result_child" };

// A conversation id a client may resume. Thread/session ids are UUID-like; the first
// character may not be "-" (argv would read it as a flag) and no path or whitespace is
// allowed. Anything else is rejected before it can reach the CLI.
const RESUME_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

// Adapter metadata.model defaults when nothing is configured. These are shown in the UI
// but must never be remembered as a model id (see emitNormalized).
const MODEL_LABELS = new Set(["codex default", "opencode default"]);

// Cap what ONE event contributes to the log. It is replayed in full to every joining
// client and re-serialized into the snapshot on every debounce tick, and a replay window
// is a single wire frame — so one unbounded event can put the whole window over the cap
// and cost the client its history. Walks the payload rather than naming fields: the
// offenders are not only a tool's `output` but a Write tool's `input.content` (50KB seen)
// and a long `thinking` block (28KB seen), each of which used to ride through untouched.
//
// Copy-on-write, so it is cheap enough to run on every event: a payload with nothing to
// truncate comes back as the SAME reference and allocates nothing — which matters for
// `delta`, emitted once per token.
function capDeep(value) {
  if (typeof value === "string") {
    return value.length > AI_MAX_TOOL_OUTPUT ? `${value.slice(0, AI_MAX_TOOL_OUTPUT)}\n… [truncated]` : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const next = capDeep(v);
      if (next !== v) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out = {};
    for (const k of Object.keys(value)) {
      const next = capDeep(value[k]);
      if (next !== value[k]) changed = true;
      out[k] = next;
    }
    return changed ? out : value;
  }
  return value;
}

// The one door every event takes into the log — live, adopted from the CLI's transcript,
// or read back from a snapshot written before these caps existed. Capping at the emit
// site alone left old logs unbounded on every load. Called for every event, so the skip
// list below is a perf guard, not a safety one: an event type missing from it is capped.
function capEvent(event, data) {
  if (!data) return data;
  // Metadata the client renders as-is; nothing in it is a payload worth truncating.
  if (event === "init" || event === "options_changed" || event === "stats") return data;
  return capDeep(data);
}

// A stored seq is a position, and positions move: compaction folds deltas and the event
// cap sheds the head, so a snapshot can hold seqs that repeat or run backwards. The
// client's scroll-up walks `e.seq >= before` and stops at the first such event, hiding
// every turn before it — so the log is renumbered on load.
function renumber(events) {
  return (events || []).map((ev, i) => (ev.seq === i + 1 ? ev : { ...ev, seq: i + 1 }));
}

// A snapshot written before capEvent existed holds raw payloads, and one of those makes
// every replay window over the wire cap for as long as the file lives. Idempotent: an
// event that already went through the cap is returned untouched.
function capLog(events) {
  return (events || []).map((ev) => {
    const data = capEvent(ev.event, ev.data);
    return data === ev.data ? ev : { ...ev, data };
  });
}

// Is the CLI's own transcript the fuller store? "Fuller" is counted in EVENTS, never in
// turns: the event cap sheds the HEAD of the log, and the head is where the prompts are —
// so a chat left open keeps thousands of recent tool events and loses every
// `user_message` it ever had (measured: 35 events left of 10,325, none of them a prompt).
// Compared turn-for-turn that log held 0 of the transcript's 9 and passed; compared as a
// whole it is 35 against 520. The `user_message` guard is what keeps a transcript of pure
// tool noise from replacing a real conversation.
//
// ONE rule, read by all three doors that rebuild a log (the constructor's snapshot
// top-up, recoverIfThinner on a hydrate, _fillGap after a missed stretch). Written out
// per door it had already drifted: two counted events and one counted turns, so the same
// log was "thin" to one door and "healthy" to another — which is how a pane came back
// short while /resume, a different door, showed the whole chat.
function isFullerLog(recovered, current) {
  if (!recovered?.length) return false;
  if (!recovered.some((e) => e.event === "user_message")) return false;
  return recovered.length > (current?.length || 0);
}

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
    // Codex goal tracking: the read in flight (so concurrent inits share it) and the
    // last emitted goal (so a reconnect does not re-append an unchanged one).
    this.goalReading = null;
    this.goalKey = null;

    const snap = loadSessionSnapshot(id, engine);
    // The CLI process for a daemon-backed engine is not born here: `start()` (called
    // by aiSocket right after) decides between starting one and adopting the one the
    // daemon is already running. This only carries the id across that gap.
    this.proc = MANAGED_ENGINES.has(engine) ? new DaemonProc({ procId: id }) : null;
    // Lines already parsed into this session's log, so a re-attach fetches only the
    // rest. The daemon numbers lines itself and the CLI restarts on a new process, so
    // this watermark belongs to the process the snapshot was written against.
    this.consumedLines = snap?.consumedLines || 0;
    // Line numbers belong to a process, so the watermark is only meaningful against the
    // one it was taken from. `null` (a legacy snapshot) means "not known", which is
    // what makes the first adopt replay the turn whole rather than skip its head.
    this.consumedEpoch = snap?.consumedEpoch ?? null;
    this.ready = null;
    // The conversation the client is opening, under the name the host sends it by.
    // Codex calls it a thread, the rest a session id; whichever arrives, the adapter
    // must be born bound to it, or the pane's first turn starts a new conversation.
    // `cliSessionId` is client-supplied and becomes CLI argv, so it is validated the
    // same way `setOptions({ resume })` validates it — an id starting with "-" would
    // otherwise be read as a flag (e.g. bypassing the sandbox).
    const requestedId = typeof options.cliSessionId === "string" && RESUME_ID_RE.test(options.cliSessionId)
      ? options.cliSessionId
      : null;
    const bindId = snap?.threadId || snap?.cliSessionId || requestedId || options.threadId || options.sessionId || null;
    this.threadId = engine === AI_ENGINES.CODEX ? bindId : null;
    this.cliSessionId = engine === AI_ENGINES.CODEX ? null : bindId;
    // No snapshot of its own yet (a chat opened from the history list, or an agent
    // restarted): replay the conversation from the CLI's own store, so the pane shows
    // it instead of an empty log. A snapshot wins — it is this session's own state.
    this.history = snap ? capLog(renumber(compactEvents(snap.events))) : [];
    // A snapshot can be thin — a legacy file, or one written just before a crash. The
    // CLI's own transcript is the fuller store, so when it knows more turns than the
    // snapshot does, it wins. Only ever upward: a good snapshot is never replaced.
    //
    // The count of turns is NOT what "thin" means. The event cap sheds the head of the
    // log, and the head is where the prompts are: a chat left open long enough keeps its
    // recent tool events (thousands of them, well past AI_MAX_EVENTS) and loses every
    // `user_message` it ever had — measured 35 events left of 10,325, zero of them a
    // prompt. Compared turn-for-turn, that log held 0 the transcript's 9, so it passed;
    // compared as a whole it is 35 events against 520. So the transcript is asked
    // whenever it would bring MORE EVENTS back, which is the loss that actually happened.
    if (bindId) {
      const recovered = recoverFromTranscript(engine, this.cwd, bindId);
      if (isFullerLog(recovered, this.history)) this.history = renumber(capLog(recovered));
    }
    // Where the next event's seq comes from. Seed from the log rather than the snapshot
    // field so a snapshot written before this counter existed still continues upward.
    this.seqCounter = this.history.at(-1)?.seq || 0;
    // Snapshot write in flight / coalesced, so a streaming turn does not re-serialize
    // the whole log on every delta.
    this.persisting = false;
    this.persistAgain = false;
    this.persistTimer = null;
    this.model = snap?.model || options.model || "";
    // Reasoning effort the session runs with. Empty means "the CLI's own config decides"
    // — the composer falls back to reading that, so it never shows a level nobody chose.
    this.effort = snap?.effort || options.effort || "";
    // Restored so a reload keeps the mode the user picked (codex/opencode run a fresh
    // CLI per turn, so the mode has to be re-sent with every prompt). A session the
    // host has never seen starts at the engine's own default mode, sent by the client.
    this.permissionMode = snap?.permissionMode || options.mode || options.defaultMode || null;
    // Discovered at connect time by aiSocket; kept so a cleared log can be re-seeded
    this.skills = [];
    this.idleTimer = null;

    if (!options.mock) {
      this.ready = this.initAdapter();
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
    // Only claude's CLI is spawned with a mode; the rest carry it through setOptions,
    // which each engine maps to its own flags.
    const mode = this.permissionMode || this.options.mode || "default";

    switch (this.engine) {
      case AI_ENGINES.CLAUDE:
        mine = new ClaudeAdapter({ cwd: this.cwd, onEvent, proc: this.managed ? this.proc : null, hostSessionId: this.id });
        this.adapter = mine;
        // Set spawn-time options BEFORE start(): setOptions would restart the CLI,
        // and calling start() afterwards would spawn a second process. Both paths
        // honour the resumed conversation id (or /resume silently starts a new one)
        // and the session's own permission mode (or it falls back to the CLI default).
        if (this.effort) mine.effort = this.effort;
        return this._startManaged(mine, mode);
      case AI_ENGINES.CODEX:
        mine = new CodexAdapter({
          cwd: this.cwd,
          onEvent,
          proc: this.managed ? this.proc : null,
          threadId: this.threadId,
          model: this.model || this.options.model,
          hostSessionId: this.id
        });
        this.adapter = mine;
        // Mode is re-sent on every rebuild: the CLI is spawned fresh per turn, and the
        // stored mode is what a reload or a /clear must restore.
        if (this.permissionMode || this.options.model || this.options.effort || this.options.sandbox || this.options.flags) {
          mine.setOptions({ ...this.options, mode: this.permissionMode || this.options.mode });
        }
        return this._startManaged(mine, mode);
      case AI_ENGINES.OPENCODE:
        mine = new OpenCodeAdapter({
          cwd: this.cwd,
          onEvent,
          proc: this.managed ? this.proc : null,
          sessionId: this.cliSessionId,
          model: this.model || this.options.model,
          hostSessionId: this.id
        });
        this.adapter = mine;
        if (this.permissionMode || this.options.model || this.options.variant || this.options.flags) {
          mine.setOptions({ ...this.options, mode: this.permissionMode || this.options.mode });
        }
        return this._startManaged(mine, mode);
      case AI_ENGINES.ANTIGRAVITY:
        mine = new AntigravityAdapter({
          cwd: this.cwd,
          onEvent,
          proc: this.managed ? this.proc : null,
          conversationId: this.cliSessionId,
          model: this.model || this.options.model,
          hostSessionId: this.id
        });
        this.adapter = mine;
        if (this.permissionMode || this.options.model || this.options.flags) {
          mine.setOptions({ ...this.options, mode: this.permissionMode || this.options.mode });
        }
        return this._startManaged(mine, mode);
      default:
        throw new Error(`Unsupported engine: ${this.engine}`);
    }
  }

  // A managed chat outlives an agent restart: the daemon holds the CLI and the agent
  // re-attaches to it, so a turn running during an update keeps running and only the
  // lines produced while nobody was watching have to be fetched.
  get managed() {
    return MANAGED_ENGINES.has(this.engine) && daemonClient.isConnected();
  }

  async _startManaged(adapter, mode) {
    // A process already running under this id IS this chat's turn — the agent just
    // restarted. Adopting it is the whole point: spawning a second CLI would resume
    // the same conversation as a second writer and lose the turn in flight.
    if (this.managed) {
      const attached = await adapter.adopt(this.consumedLines, this.consumedEpoch);
      if (attached.alive || attached.lines?.length) {
        this.adopted = true;
        this._replay(attached);
        return attached;
      }
    }
    // Nothing to adopt (no daemon, or the process ended while we were away): this is a
    // new process, so its line numbering starts over and so does the watermark.
    this.adopted = false;
    this.consumedLines = 0;
    this.consumedEpoch = null;
    // A turn-per-CLI engine has nothing to start until the user asks for a turn; only
    // claude holds one process for the whole conversation.
    if (this.engine !== AI_ENGINES.CLAUDE) return null;
    const fetch = await adapter.start(mode, this.cliSessionId);
    this._replay(fetch);
    return fetch;
  }

  // Feed fetched lines to the adapter in order, then let the live ones through. The
  // watermark advances only past what was parsed, so a crash mid-replay re-fetches.
  _replay(fetch) {
    if (!fetch) return;
    // The daemon's ring can have dropped lines this reader never saw — the process kept
    // talking while no agent was attached, and its buffer is finite. Those lines are
    // gone from the wire, so the conversation would come back with a silent hole in it.
    // Kept for diagnostics: how much the daemon's ring had already dropped when this
    // reader came back.
    this.lastMissed = fetch.missed || 0;
    if (fetch.missed > 0) this._fillGap(fetch.missed);
    // One door for every carrier: feeds the fetched lines, lets the held ones through,
    // closes stdin. `commit` decodes on the way in, so no caller has to know whether the
    // lines arrived live (a string) or from a fetch (a numbered b64 record).
    fetch.commit?.((line) => this.adapter.feed(line));
    // The daemon's own line number is the watermark a restart resumes from, and it is
    // only honest once release() has fed through the lines that arrived mid-replay.
    // The epoch rides with it: line numbers belong to a process, and a later turn is a
    // different one numbering from 1 again.
    this.consumedLines = this.proc?.lineNo || 0;
    this.consumedEpoch = this.proc?.epoch ?? null;
  }

  /**
   * Adopt a rebuilt log, exactly the way a hydrate delivers one: reset the client's
   * view, then ship only the tail and say where that window begins. Shipping a whole
   * conversation down the live bus is what made `/resume` slow — the rest belongs to
   * the scroll-up fetch, which needs `fromSeq` to know what it is missing.
   */
  // The CLI's own store is the fuller one: the log here is capped (AI_MAX_EVENTS sheds
  // its head) and a snapshot can be short. Called before a hydrate is answered, so the
  // window it reports covers everything the pane could ask for. The test is isFullerLog —
  // a good log is never replaced by a shorter one.
  // Returns whether it replaced the log.
  recoverIfThinner() {
    if (!this.cliSessionId || this.isTurnRunning) return false;
    const recovered = recoverFromTranscript(this.engine, this.cwd, this.cliSessionId);
    if (!isFullerLog(recovered, this.history)) return false;
    this._adoptLog(recovered);
    return true;
  }

  // A rewind changed the conversation under us: the CLI's own store is now shorter than
  // the log this host has been accumulating. Rebuild from that store and broadcast a
  // reset, or every client keeps rendering the turns the rewind just discarded.
  // Returns false when the engine keeps no transcript to rebuild from — the caller
  // decides what to say rather than showing a conversation that no longer exists.
  reloadFromStore() {
    if (!this.cliSessionId) return false;
    const recovered = recoverFromTranscript(this.engine, this.cwd, this.cliSessionId);
    if (!recovered) return false;
    this._adoptLog(recovered);
    return true;
  }

  /**
   * Make the CLI re-read its conversation from disk.
   *
   * A rewind rewrites the transcript underneath a process that is holding the old
   * conversation in memory — the file is read once, at spawn, via `--resume`. Without
   * this the CLI would answer from the turns the rewind just discarded and append them
   * back, so the cut would undo itself on the next prompt.
   *
   * Deliberately not `setOptions({ resume })`: that only restarts when the id CHANGES,
   * and a rewind keeps the same id — which is the point of it. A respawn under the same
   * id is what makes the truncated file authoritative.
   *
   * Stop BEFORE the transcript is rewritten and start after: the old process is the only
   * other writer, and killing it first means it cannot flush the discarded turns back
   * over the cut on its way out.
   */
  async stopAdapter() {
    if (this.options.mock || !this.adapter) return false;
    this.isTurnRunning = false;
    this.clearIdleWatchdog();
    try { await this.adapter.stop(); } catch {}
    return true;
  }

  async startAdapter() {
    if (this.options.mock || !this.adapter) return false;
    this.ready = this.initAdapter();
    await this.ready;
    return true;
  }

  _adoptLog(events) {
    // Numbered from 1 on purpose: the reset tells every client this is a NEW log. The
    // counter restarts with it, or the next live event would carry a seq from the log
    // that just ended and the client would drop it as already applied.
    const log = renumber(capLog(events));
    this.seqCounter = log.length;
    this.history = log;
    // One door for the reset replay, same as the hydrate ack: it steps over any event too
    // wide for a single frame, or the carrier refuses the whole reset.
    const { events: replay, hasMore, fromSeq } = replayWindow(log, AI_REPLAY_BYTES);
    this.onEvent?.(this.id, "conversation_reset", { hasMore, fromSeq });
    for (const ev of replay) this.onEvent?.(this.id, ev.event, ev.data, ev.seq);
    this.flushSaveSnapshot();
    return log;
  }

  // A gap is recoverable: the CLI writes its own transcript, and that store is not
  // bounded by the daemon's buffer. Rebuilding from it gives back the whole
  // conversation; only when there is no transcript does the hole have to be shown.
  _fillGap(missed) {
    const recovered = this.cliSessionId
      ? recoverFromTranscript(this.engine, this.cwd, this.cliSessionId)
      : null;
    // The same test as the other two doors. Counting TURNS here was the drift that made
    // this door refuse a rebuild the others took: a capped log keeps its recent tool
    // events and loses its prompts, so "no new turns" said healthy about a log that had
    // lost the whole head of the conversation.
    if (isFullerLog(recovered, this.history)) {
      this._adoptLog(recovered);
      return;
    }
    // Nothing to rebuild from. Say so in the log: a visible gap beats a conversation
    // that quietly skips a step.
    this.emitNormalized("ansi", {
      chunk: `\r\n[9remote] ${missed} dòng output đã mất trong lúc agent khởi động lại.\r\n`
    });
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
      // The thread id is what codex's goal RPC keys on, so it is only worth looking a
      // goal up once it is known — and it changes with a resume, so re-read on each init.
      if (this.engine === AI_ENGINES.CODEX && data?.threadId) this.refreshGoal(data.threadId);
    }
    // A sub-agent's tool calls are nested under the Agent/Task card that spawned them,
    // so the live path would have to nest them on arrival anyway. Record and broadcast
    // them as their own `tool_child` event instead: the replay rebuilds the nesting
    // from the log (the parent's own events carry no `subagent` flag), and an old log
    // whose child events still say tool_start simply drops them rather than floating
    // a sub-agent's internals loose on the timeline.
    data = capEvent(event, data);
    const childEvent = CHILD_EVENTS[event];
    const wire = data?.parentToolUseId && childEvent ? { event: childEvent, data } : { event, data };

    // A seq on every event is what lets a hydrating client drop the live events it
    // already replayed, and what marks where its scroll-up window ends. It is a counter,
    // never the array length: compaction and the event cap both shrink the log, and a
    // seq derived from its length went backwards (or stuck at AI_MAX_EVENTS+1), which
    // left the client unable to walk further back than the last such step.
    const seq = ++this.seqCounter;
    // record=false pushes the event to clients without appending to the replay log —
    // used for per-connect metadata that would otherwise accumulate on every F5
    if (record) {
      this.history.push({ seq, event: wire.event, data, timestamp: Date.now() });
      if (this.history.length > AI_MAX_EVENTS) this.history.shift();
    }
    this.onEvent?.(this.id, wire.event, data, seq);
    if (record) this.scheduleSaveSnapshot();
    if (this.isTurnRunning) this.armIdleWatchdog();

    // Any terminal event releases the turn. Missing `error`/`exit` from that set left the
    // flag stuck true after a failed spawn, and the ack hands that flag to every client —
    // so the pane came back from an F5 spinning on a process that was already gone.
    if (TURN_END_EVENTS.has(event)) {
      this.isTurnRunning = false;
      this.clearIdleWatchdog();
      this.history = compactEvents(this.history);
      this.flushSaveSnapshot();
      this.applyPendingOptions();
    }
  }

  // True when this session already has an init in its replay log
  hasRecordedInit() {
    return this.history.some((e) => e.event === "init");
  }

  // Codex's own persistent goal (the TUI's `/goal`). It lives in codex's state DB and
  // only surfaces over its app-server, so it is read asynchronously and emitted as its
  // own event rather than folded into `init`.
  async refreshGoal(threadId) {
    if (this.engine !== AI_ENGINES.CODEX || this.goalReading === threadId) return;
    this.goalReading = threadId;
    const goal = await readThreadGoal(threadId, this.cwd).catch(() => null);
    this.goalReading = null;
    // A stale read (the thread moved on, or the session ended) must not stamp its
    // goal over the current one.
    if (this.threadId !== threadId) return;
    const key = goal ? `${goal.objective}|${goal.status}` : "";
    // Compare against the log, not just an in-memory field: init fires on every connect
    // (F5, extra tab) and again after an agent restart that restored the snapshot, and
    // each of those would otherwise append a duplicate of a goal that never changed.
    if (key === this.goalKey || key === this.lastRecordedGoalKey()) return;
    this.goalKey = key;
    // Always record a clearing: a client joining later must see there is no goal, and
    // the key being empty is exactly what tells it so.
    this.emitNormalized("goal", { goal });
  }

  // The goal key of the newest `goal` event in the replay log ("" when none, or when
  // the last one recorded was a clearing).
  lastRecordedGoalKey() {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].event !== "goal") continue;
      const g = this.history[i].data?.goal;
      return g ? `${g.objective}|${g.status}` : "";
    }
    return null;
  }

  // Re-armed on every event of a running turn: silence past the window means the CLI is
  // wedged, which would otherwise leave the chat spinning with no reply and no error.
  //
  // "Silence" counts every sign of life, not just chat events: a terminal sharing this
  // session that is still streaming output is a turn making progress (a long build), so
  // the clock runs from there instead of the turn being killed under it.
  armIdleWatchdog(ms = AI_TURN_IDLE_TIMEOUT_MS) {
    this.clearIdleWatchdog();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.isTurnRunning) return;
      // A gate the CLI is waiting on is not a stall — it is silent because nobody has
      // answered it, and the watchdog used to SIGINT the CLI out from under the card
      // after two minutes of the user reading the question.
      if (this.adapter?.pendingRequests?.size) return;
      const quietFor = Date.now() - getLastOutputAt(this.id);
      // Still printing — give the turn a fresh window rather than killing it mid-build.
      if (quietFor < OUTPUT_LIVE_WINDOW_MS) return this.armIdleWatchdog();
      // Otherwise the clock runs from that last output: wait out whichever is longer.
      if (quietFor < AI_TURN_IDLE_TIMEOUT_MS) return this.armIdleWatchdog(AI_TURN_IDLE_TIMEOUT_MS - quietFor);
      try { this.adapter?.stop(); } catch {}
      // Its own event, not `error`: this is the watchdog guessing at a stall, and a
      // false positive must not paint an error bubble over a turn that is merely slow.
      // `error` stays reserved for failures the CLI actually reported.
      this.emitNormalized("stall", {
        message: `No response from the ${this.engine} CLI for ${Math.round(AI_TURN_IDLE_TIMEOUT_MS / 1000)}s — the turn was stopped. This usually means the CLI stalled on startup; try again.`
      });
    }, ms);
  }

  clearIdleWatchdog() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Coalesce writes while a turn streams. A sync write per event would stall the
   * agent's socket flush, but leaving it to the turn boundary loses everything a
   * hard kill interrupts — so it is the middle ground, on a short debounce.
   */
  scheduleSaveSnapshot() {
    if (this.destroyed || this.persistTimer) return;
    // While a turn streams, most events are delta slices that only ever grow one
    // message — so the write is compacted (see saveSnapshot) and the window is the
    // long one. A turn boundary still flushes synchronously, which is what an unclean
    // death is actually measured against.
    const delay = this.isTurnRunning ? AI_PERSIST_STREAM_MS : AI_PERSIST_DEBOUNCE_MS;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.saveSnapshot();
    }, delay);
    this.persistTimer.unref?.();
  }

  // Turn boundaries (and a shutdown) pay a synchronous write: a crash right after one
  // leaves a whole exchange intact, not a half-stream.
  flushSaveSnapshot() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.saveSnapshot(true);
  }

  saveSnapshot(sync = false) {
    // A write already in flight: fold this one into it rather than interleaving two
    // writes of a log that is still growing, which can land them out of order.
    if (this.persisting) { this.persistAgain = true; return; }
    this.persisting = true;
    try {
      // A turn in flight is mostly delta slices — hundreds of them per turn, each a
      // few bytes. Compacting on the way out keeps the file (and the bytes written
      // every debounce tick) proportional to the conversation, not to its chunkiness.
      // The in-memory log stays whole: clients replay slices, the snapshot need not.
      const events = this.isTurnRunning ? compactEvents(this.history) : this.history;
      const payload = JSON.stringify({
        engine: this.engine,
        cwd: this.cwd,
        threadId: this.threadId,
        cliSessionId: this.cliSessionId,
        model: this.model,
        effort: this.effort,
        permissionMode: this.permissionMode,
        createdAt: this.createdAt,
        // Where in the CLI's own output stream this log ends, and which process that
        // stream belonged to. A restarted agent re-attaches and asks for everything
        // after it, which is what makes a turn that kept running while it was down
        // arrive whole and exactly once.
        consumedLines: this.consumedLines,
        consumedEpoch: this.consumedEpoch,
        events
      });
      if (sync) {
        fs.writeFileSync(aiSnapshotFile(this.id, this.engine), payload);
        this.persisting = false;
        if (this.persistAgain) { this.persistAgain = false; this.saveSnapshot(true); }
        return;
      }
      fs.writeFile(aiSnapshotFile(this.id, this.engine), payload, () => {
        this.persisting = false;
        if (this.persistAgain) { this.persistAgain = false; this.saveSnapshot(); }
      });
    } catch {
      this.persisting = false;
    }
  }

  sendPrompt(prompt, attachments = null) {
    // Clear is a host-side reset, not a message. Without this the old log survived a
    // Clear and came back on the next F5 — and the literal "/clear" was recorded as a
    // prompt on top of it.
    if (String(prompt).trim() === "/clear") {
      // Refused mid-turn: rebuilding the adapter kills the CLI process, which would
      // discard the turn the user is watching. Stop first, then clear.
      if (this.isTurnRunning) {
        this.emitNormalized("error", { message: "Turn is still running — stop it before /clear." });
        return;
      }
      // Drop the CLI conversation too, or the "cleared" chat resumes on the next
      // restart: the adapter holds a live thread/session id and this session's copy of
      // it is written straight into the snapshot. Rebuilding the adapter is what
      // silences the old process — its handlers stand down once this.adapter moves on.
      this.threadId = null;
      this.cliSessionId = null;
      this.history = [];
      // The new log's seqs begin at 1 again, and the counter must restart with them —
      // carrying the old one over would drop this log's first events as already applied.
      this.seqCounter = 0;
      // A fresh process numbers its lines from scratch; the old watermark would make
      // the next agent skip the new conversation's first lines as "already consumed".
      this.consumedLines = 0;
      this.consumedEpoch = null;
      this.isTurnRunning = false;
      this.clearIdleWatchdog();
      this.flushSaveSnapshot();
      if (!this.options.mock && !this.managed) {
        // Kill before rebuilding — initAdapter replaces the reference, and an adapter
        // dropped without stop() leaves its CLI process running with nothing reading it.
        // Under the daemon there is nothing to rebuild: a turn-per-CLI engine has no
        // process between turns, and claude's carries on with the cleared conversation.
        try { this.adapter?.stop(); } catch {}
        this.ready = this.initAdapter();
      }
      const init = this.metadata();
      this.history.push({ seq: ++this.seqCounter, event: "init", data: init, timestamp: Date.now() });
      this.onEvent?.(this.id, "conversation_reset", { hasMore: false, fromSeq: 0 });
      this.onEvent?.(this.id, "init", init);
      this.flushSaveSnapshot();
      return;
    }

    this.lastPrompt = prompt;
    this.isTurnRunning = true;
    // The echoed message carries the attachment names so every client can render them
    // under the bubble — the base64 never rides the replay log.
    this.emitNormalized("user_message", { text: prompt, attachments: attachmentMeta(attachments) });
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

  // The gate the CLI is holding right now, in the shape the client's card renders.
  // A replay is a byte tail, so the permission_request that opened a gate can fall off
  // its front — and without this the card never comes back while the CLI waits forever
  // on an answer nobody can see. Null when nothing is pending (every other engine).
  pendingPermission() {
    // The newest entry, matching what a replay produced: reduceSessionEvents lets each
    // permission_request overwrite the last, so the card shown was always the latest.
    const map = this.adapter?.pendingRequests;
    if (!map?.size) return null;
    const requestId = [...map.keys()].at(-1);
    const req = map.get(requestId);
    return { requestId, tool: req.toolName || "", input: req.input || {} };
  }

  resolvePermission(requestId, behavior, message) {
    // An engine with no gate of its own returns undefined; only an explicit false means
    // the CLI refused the answer, and the client must keep its card for that.
    const handled = this.adapter?.resolvePermission?.(requestId, behavior, message);
    if (handled === false) return false;
    // Every other client watching this session must drop its permission card too —
    // otherwise a second surface keeps showing a gate nobody is waiting on.
    this.emitNormalized("permission_resolved", { requestId, behavior });
    return true;
  }

  resolveQuestion(requestId, answers) {
    const handled = this.adapter?.resolveQuestion?.(requestId, answers);
    if (handled === false) return false;
    this.emitNormalized("permission_resolved", { requestId, behavior: "allow" });
    return true;
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
    // Same for the reasoning effort, which the init event publishes for the composer.
    if (rest?.effort) this.effort = rest.effort;
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
      // Same delivery as opening this conversation from the history list: reset + tail,
      // with the rest left to the scroll-up fetch.
      this._adoptLog(recoverFromTranscript(this.engine, this.cwd, resume) || []);
      // TEMP DIAGNOSTIC — an empty rebuild is what a rewind to the first turn SHOULD
      // produce, and also what a failed transcript read produces. Those two look
      // identical from the pane (a blank conversation), so say which one happened and
      // whether the file the read needed exists. Remove once rewind is confirmed.
      if (!this.history.length) {
        logger.info(`[ai] rewind left an empty log: engine=${this.engine} resume=${resume} cwd=${this.cwd}`);
      }
    }
    // mode/model/effort/resume are all spawn-time flags, so applying one restarts the
    // CLI — which kills a turn in flight. Mid-turn the change is remembered instead and
    // applied when the turn ends: a switch the user just made must not silently no-op,
    // and must not throw away the answer they are watching.
    if (this.isTurnRunning) {
      this.restartPending = true;
      if (rest?.mode || rest?.effort || resume) this.flushSaveSnapshot();
      return;
    }
    // Forward only the validated id; the adapter must never see an unvalidated value.
    // The restart returns the lines its new process already produced — parsed in order,
    // exactly like a fresh start.
    // A restart returns its new process's lines and holds the live ones until they are
    // released. Replaying only on `resume` left a mode/model change holding every line
    // forever — the chat went silent with no error.
    const fetch = this.adapter?.setOptions?.({ ...opts, resume });
    if (fetch?.then) fetch.then((f) => this._replay(f));
    // effort/mode are snapshot state: a reload or /clear rebuild must restore them.
    if (rest?.mode || rest?.effort || resume) this.flushSaveSnapshot();
  }

  // A change deferred while a turn was running, applied the moment it ends.
  applyPendingOptions() {
    if (!this.restartPending) return;
    this.restartPending = false;
    const fetch = this.adapter?.setOptions?.({ mode: this.permissionMode, model: this.model, effort: this.effort });
    if (fetch?.then) fetch.then((f) => this._replay(f));
  }

  // Run the engine CLI's own health command (claude doctor / codex doctor /
  // opencode debug). Resolved from a static spec so no CLI process is spawned to
  // answer it — constructing an adapter would start a real session.
  async runDoctor() {
    return runEngineDoctor(this.engine, this.cwd, this.options.mock);
  }

  stop() {
    // The turn is what the user is stopping, and a control request keeps the CLI (and
    // its conversation) alive. A signal is only the fallback when it cannot be written.
    const sent = this.adapter?.interrupt?.();
    if (!sent) this.adapter?.signal?.("SIGINT");
    this.emitNormalized("stopped", {});
  }

  destroy() {
    this.clearIdleWatchdog();
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    // The stop is async under the daemon, so the unlink below has to wait for it —
    // otherwise the stop's own 'exit' event schedules a debounced write that puts the
    // snapshot straight back after we deleted it.
    const stopped = this.options.mock ? Promise.resolve() : this.adapter?.stop();
    // The exit event is emitted BEFORE the file goes, and persistence is off from here:
    // emitting after the unlink would schedule a write that puts the snapshot straight
    // back, and the next boot would resurrect a chat with no terminal behind it.
    this.destroyed = true;
    this.emitNormalized("stopped", {});
    const file = aiSnapshotFile(this.id, this.engine);
    const drop = () => { try { fs.unlinkSync(file); } catch {} };
    if (stopped?.then) stopped.then(drop, drop);
    else drop();
  }
}
