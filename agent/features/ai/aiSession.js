// Represents a single active AI session (Claude, Codex, or OpenCode)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AI_ENGINES, AI_TURN_IDLE_TIMEOUT_MS, AI_ASYNC_IDLE_TIMEOUT_MS, AI_DOCTOR_TIMEOUT_MS, AI_PERSIST_DEBOUNCE_MS, AI_PERSIST_STREAM_MS, AI_MAX_EVENTS, AI_MAX_TOOL_OUTPUT } from "./constants.js";
import { getExtendedEnv } from "./adapters/env.js";
import { recoverFromTranscript } from "./transcript.js";
import { readClaudeSessionState, readNewAttachments } from "./claudeTranscript.js";
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
import { getLastOutputAt, touchOutput, OUTPUT_LIVE_WINDOW_MS } from "../terminal/statusManager.js";
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

// Records the CLI STREAMS but never writes down. Measured: across a 7.7 MB transcript the
// harness persisted zero `thinking_tokens` and zero `hook_progress` — it emits them for a
// live spinner and lets them go. Keeping them here cost the pane its history: on a real
// session telemetry was 8.6% of the log but 807% of one AI_REPLAY_BYTES window, so the
// window the client was sent was almost all telemetry and the prompts fell outside it —
// scrolling up showed nothing, and an F5 came back empty.
//
// Broadcast, not recorded: that is what `record = false` is for, and it is the rule the
// per-connect metadata already follows. Nothing replays one, because nothing reads one.
const LIVE_ONLY_CLI_SUBTYPES = new Set([
  "thinking_tokens",
  "tool_progress",
  "hook_started",
  "hook_progress",
  "hook_response",
  "status",
  "control_response"
]);

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

// An attachment record as the pane reads it, without the two fields no reader touches.
//
// `rendered` is the harness's OWN rendering of the record — the text it would print in the
// TUI — and it is the larger half: measured on a real chat, 3.5KB of a 3.5KB
// `hook_success`, 9KB of a 9.6KB `edited_text_file`. The pane never reads it: it reads
// `attachment.content` / `attachment.prompt` / `attachment.filename`, which are the
// harness's own fields and the ones its TUI renders from too. It is dropped here rather
// than at the reader so it never reaches the log, the snapshot, or a replay window.
//
// `snippet` is the WHOLE file re-read (8KB measured), not the change — `stripAttachmentBody`
// drops it on the transcript path for the same reason, and the live path was keeping it.
//
// Together 30% of a 6.7MB log on the worst real chat, and a replay window is 32KB.
// Copy-on-write, like capDeep: a record with neither field comes back as the SAME
// reference, so an attachment the harness sends plainly allocates nothing.
function slimAttachment(record) {
  if (!record?.attachment) return record;
  if (record.rendered === undefined && record.attachment.snippet === undefined) return record;
  const { rendered, attachment, ...rest } = record;
  if (attachment.snippet === undefined) return { ...rest, attachment };
  const { snippet, ...body } = attachment;
  return { ...rest, attachment: body };
}

// The one door every event takes into the log — live, adopted from the CLI's transcript,
// or read back from a snapshot written before these caps existed. Capping at the emit
// site alone left old logs unbounded on every load. Called for every event, so the skip
// list below is a perf guard, not a safety one: an event type missing from it is capped.
function capEvent(event, data) {
  if (!data) return data;
  // Metadata the client renders as-is; nothing in it is a payload worth truncating.
  if (event === "init" || event === "options_changed" || event === "stats") return data;
  if (event === "cli_event" && data.type === "attachment") {
    const record = slimAttachment(data.record);
    return record === data.record ? data : { ...data, record };
  }
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

// The CLI's transcript is the authority on what this conversation IS; the log here is a
// cache of what the agent happened to see. They disagree in one direction only — the log
// loses: AI_MAX_EVENTS sheds its head (and the head is where the prompts are), and
// compactEvents folds deltas. Measured on one live chat: 65 events here, 0 prompts;
// 151 in the transcript, 1 prompt.
//
// So a hydrate rebuilds, always, instead of asking a rule whether the log looks thin.
// Every "thin enough to replace?" test written for this drifted from the others — two
// counted events while one counted turns — and each drift showed up as a pane that came
// back short on one door while /resume, which never asked that question, showed the whole
// chat. The transcript is read on a hydrate; when it has nothing, the log stands.
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

/**
 * Put carried records back among the rebuilt ones, wherever they still belong.
 *
 * The rebuilt log is usually SHORTER than the one it replaces — the head is shed past
 * `AI_MAX_EVENTS`, and the transcript rebuilds only what it holds. So an old index cannot
 * be compared against the new array: a record that sat at position 5 of a 6-event log has
 * no home in a 2-event one, and a naive walk puts it at the end AND leaves earlier records
 * unfiled, which is how carried records ended up duplicated at the tail.
 *
 * What survives a rebuild is the conversation's SHAPE, so position is taken from it: count
 * how many live events preceded the record, then put it before the same count of rebuilt
 * ones. Past the end is a legitimate answer — it arrived after everything the transcript
 * could reconstruct — and it keeps arrival order among the records that share it.
 */
function insertByIndex(events, carried) {
  const out = [];
  let src = 0;
  const liveSeen = (upto) => {
    let n = 0;
    for (let i = 0; i < upto; i++) if (!(carriedAt.has(i))) n++;
    return n;
  };
  const carriedAt = new Set(carried.map(({ i }) => i));
  for (const { e, i } of carried) {
    const at = Math.min(liveSeen(i), events.length);
    while (src < at) out.push(events[src++]);
    out.push(e);
  }
  while (src < events.length) out.push(events[src++]);
  return out;
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
    // Async work still in flight, by the tool id that launched it — see armAsyncWatchdog.
    // ponytail: the FALLBACK clock. The CLI states a task's life in task_* records, and
    // this timer only covers a CLI too old to emit them (none left at 2.1.270).
    this.asyncTimers = new Map();
    // How long the last turn took, measured by the host's own clock — the pane prints
    // "Worked for …" from this after an F5, since a client that rejoins saw neither edge.
    // A span, not two timestamps: the client's clock is a different clock, and subtracting
    // across them would print the skew. 0 means "no turn this host witnessed".
    this.turnStartedAt = 0;
    this.lastTurnMs = 0;
    this.lastPrompt = "";
    this.adapter = null;
    // Codex goal tracking: the read in flight (so concurrent inits share it) and the
    // last emitted goal (so a reconnect does not re-append an unchanged one).
    this.goalReading = null;
    this.goalKey = null;

    const snap = loadSessionSnapshot(id, engine);
    // Where the transcript was last read to, for the attachments stream-json never sends.
    // A byte offset, not a line count: the file is append-only and can be megabytes.
    //
    // A session that has never read starts at the CURRENT end of the file, not at zero.
    // Starting at zero replayed every attachment the conversation ever had — measured 72
    // `hook_success` from turns the pane had already drawn — because the rebuild already
    // put this conversation's history on screen, and these would be a second copy of it.
    this.attachmentOffset = snap?.attachmentOffset ?? null;
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
    // it instead of an empty log.
    this.history = snap ? capLog(renumber(compactEvents(snap.events))) : [];
    // A restored row marked `async` says work was handed off before this process existed,
    // and the process that held its watchdog is gone. Settle it here, or the row spins
    // forever: the client deliberately keeps `async` rows live past their turn.
    this._settleRestoredAsync();
    // The transcript is the authority, and the snapshot only a cache of it — so it is
    // read here too, not only on a hydrate. See adoptLog: every "is the log thin?" test
    // written for this drifted from the others, and the drift is what a short reopen
    // looked like. When the transcript has nothing, the snapshot stands.
    if (bindId) {
      this.history = this._rebuildFromStore(bindId) || this.history;
      this._settleRestoredAsync();
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
    // The harness states its own mode, title and last prompt as records in the transcript,
    // and it is the authority on them — the values above are 9Remote's reconstruction (a
    // mode inferred from a stream-json init, a title cut from prose, a prompt kept in
    // memory). Overridden, not merged: a value the harness wrote beats one derived from
    // watching it. Absent records leave these alone (see readClaudeSessionState).
    if (this.engine === AI_ENGINES.CLAUDE && bindId) {
      const state = readClaudeSessionState(this.cwd, bindId);
      if (state) {
        if (state.permissionMode) this.permissionMode = state.permissionMode;
        if (state.lastPrompt) this.lastPrompt = state.lastPrompt;
        // NOT `state.cwd`. The transcript records the directory the CLI STARTED in, and a
        // session object's own `cwd` is where its process will run — moving this one would
        // send the next spawn somewhere the user never chose. Kept as a separate fact for
        // the pane to show, not for the session to run on.
        if (state.cwd) this.harnessCwd = state.cwd;
        if (state.isWorktree) this.isWorktree = true;
        // The harness's own title for the conversation, kept for the history list and for
        // a terminal that follows its chat's name.
        if (state.title) this.harnessTitle = state.title;
      }
    }
    // Discovered at connect time by aiSocket; kept so a cleared log can be re-seeded
    this.skills = [];

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
          hostSessionId: this.id,
          // Which transport this chat runs on, straight from the caller. Gating this on
          // `managed` was wrong twice over: it silently dropped a transport the caller
          // HAD asked for (so the option looked broken), and the daemon is not actually
          // required — without one the adapter gets a null proc and makes its own.
          transport: this.options.transport || null
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
        // The restored effort goes through setOptions, not straight onto the field: it
        // is what publishes `effort` on the init event the composer's chip reads, and
        // it is where a model id carrying its own tier gets its suffix dropped.
        if (this.permissionMode || this.options.model || this.options.flags || this.effort) {
          mine.setOptions({ ...this.options, effort: this.effort || this.options.effort, mode: this.permissionMode || this.options.mode });
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
        // The adopted CLI may be mid-turn — the adapter sets its own flag from the
        // process being alive, and the session's copy is what gates a spawn-time option
        // (a mode/model/effort pick) from restarting the CLI out from under the answer
        // on screen.
        if (adapter.isTurnRunning) this.isTurnRunning = true;
        this._replay(attached);
        return attached;
      }
    }
    // Nothing to adopt (no daemon, or the process ended while we were away): this is a
    // new process, so its line numbering starts over and so does the watermark.
    this.adopted = false;
    this.consumedLines = 0;
    this.consumedEpoch = null;
    // A turn-per-CLI engine has nothing to start until the user asks for a turn. The
    // adapter says which it is: claude always holds one process, and codex does too when
    // it runs on the app-server transport. Asking the adapter instead of the engine name
    // is what lets codex change transports without this line knowing.
    if (!adapter.persistent && this.engine !== AI_ENGINES.CLAUDE) return null;
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
   * Read the CLI's own store and return the log it describes, or null when there is
   * nothing to read. The one place a transcript becomes a log — a chat opened from the
   * history list, a hydrate, /resume, a rewind and a gap all land here.
   *
   * The transcript is the authority on what the conversation IS; this session's log is a
   * cache of what the agent happened to see, and it loses content: the event cap sheds
   * its head (where the prompts live) and compaction folds deltas. So callers do not ask
   * whether the log looks thin — they ask the store, and keep what they have when it
   * answers nothing. Every "thin enough?" test written for this drifted from the others
   * (two counted events, one counted turns), and each drift showed as a pane that came
   * back short on one door while /resume showed the whole chat.
   */
  _rebuildFromStore(sessionId) {
    // The id reaches the CLI as argv and the filesystem as a path segment; each reader
    // validates it itself, and a client-supplied resume id is checked before it is
    // stored (see RESUME_ID_RE).
    const recovered = recoverFromTranscript(this.engine, this.cwd, sessionId);
    return recovered?.length ? renumber(capLog(recovered)) : null;
  }

  // Rebuild this session's log from the CLI's own store and tell every client to reset.
  // Runs before a hydrate is answered, so the window that ack reports covers everything
  // the pane could ask for. Returns whether it replaced the log.
  refreshFromStore() {
    if (!this.cliSessionId) return false;
    const log = this._rebuildFromStore(this.cliSessionId);
    if (!log) return false;
    this._adoptLog(log);
    return true;
  }

  // A rewind changed the conversation under us: the CLI's own store is now shorter than
  // the log this host has been accumulating. Rebuild from that store and broadcast a
  // reset, or every client keeps rendering the turns the rewind just discarded.
  // Returns false when the engine keeps no transcript to rebuild from.
  reloadFromStore() {
    if (!this.cliSessionId) return false;
    const log = this._rebuildFromStore(this.cliSessionId);
    if (!log) return false;
    this._adoptLog(log);
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
    // The CLI is going away, so nothing it launched is still running — and no result is
    // coming to settle those rows.
    this.clearAllAsyncWatchdogs();
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
    // The CLI's transcript is the authority on the CONVERSATION, and only on that: every
    // rebuild path (a hydrate, /resume, a rewind) replaces the log with what the transcript
    // can reconstruct. The harness's own records are not in it — measured, 0 of
    // `task_started` / `background_tasks_changed` / `status` / `hook_*` across 934 real
    // transcripts — so replacing the log wholesale dropped them, and a pane that reloaded
    // mid-task came back with an empty strip while the work was still running.
    //
    // Carried across, not re-emitted: the client is told this is a NEW log (the reset
    // below), and re-sending them would draw each row twice.
    //
    // Put back where they were, not appended. The pane reads order as arrival, so nailing
    // a task from turn 1 to the end of the log would surface it under turn 2. The
    // transcript's own events carry no timestamp to sort by, so position is taken from
    // what the log does know: how many live events sat before each record.
    const carried = (this.history || []).map((e, i) => ({ e, i })).filter(({ e }) => e.event === "cli_event");
    const merged = carried.length ? insertByIndex(events, carried) : events;
    // Numbered from 1 on purpose: the reset tells every client this is a NEW log. The
    // counter restarts with it, or the next live event would carry a seq from the log
    // that just ended and the client would drop it as already applied.
    const log = renumber(capLog(merged));
    this.seqCounter = log.length;
    this.history = log;
    // One door for the reset replay, same as the hydrate ack: it steps over any event too
    // wide for a single frame, or the carrier refuses the whole reset.
    const { events: replay, hasMore, fromSeq } = replayWindow(log, AI_REPLAY_BYTES);
    // The turn state rides with the log it belongs to. This reset and the ack that answers
    // the same hydrate state the same values, so the client lands on them whichever order
    // the two arrive in — and a live turn stays live, which is what keeps its stop control.
    this.onEvent?.(this.id, "conversation_reset", {
      hasMore, fromSeq,
      lastTurnMs: this.lastTurnMs,
      ...this.turnState()
    });
    for (const ev of replay) {
      // `replay: true` marks history rather than news: this log is being RE-SENT (a
      // hydrate rebuilt it from the transcript, a rewind, a /resume), so its events
      // already happened. The status mirror reads it and stands down — a rebuilt log ends
      // on a turn_complete, and replaying that turned the tab's dot amber while the turn
      // was still streaming. The pane still consumes every one: it has no other way to
      // learn what the conversation was.
      this.onEvent?.(this.id, ev.event, { ...ev.data, replay: true }, ev.seq);
    }
    this.flushSaveSnapshot();
    return log;
  }

  // A gap is recoverable: the CLI writes its own transcript, and that store is not
  // bounded by the daemon's buffer. Rebuilding from it gives back the whole
  // conversation; only when there is no transcript does the hole have to be shown.
  _fillGap(missed) {
    if (this.cliSessionId && this.refreshFromStore()) return;
    // Nothing to rebuild from. Say so in the log: a visible gap beats a conversation
    // that quietly skips a step.
    this.emitNormalized("ansi", {
      chunk: `\r\n[9remote] ${missed} dòng output đã mất trong lúc agent khởi động lại.\r\n`
    });
  }

  // What a client cannot rebuild from the log: whether a turn is live, how long the last
  // one took, and how long the live one has been going. Every door that states turn state
  // answers with this, so an ack and the reset beside it can never disagree.
  //
  // `elapsedMs` is a DURATION, not a mark: the two machines sit on different clocks, and
  // a client subtracting the host's mark from its own would print the skew. Anchored to
  // the duration, a pane that joins mid-turn picks the clock up where the host left it.
  turnState() {
    return {
      isTurnRunning: this.isTurnRunning,
      elapsedMs: this.isTurnRunning && this.turnStartedAt ? Date.now() - this.turnStartedAt : 0
    };
  }

  emitNormalized(event, data, record = true) {
    // A record the harness itself does not keep is not history — see LIVE_ONLY_CLI_SUBTYPES.
    if (record && event === "cli_event" && LIVE_ONLY_CLI_SUBTYPES.has(data?.subtype)) record = false;
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
    // Stamped on the way out, so every writer that ends a turn (/clear, /resume, a rewind)
    // is covered without repeating the bookkeeping in each of them.
    const now = Date.now();
    if (event === "user_message") {
      this.turnStartedAt = now;
      this.lastTurnMs = 0;
    } else if (TURN_END_EVENTS.has(event)) {
      if (this.turnStartedAt) this.lastTurnMs = now - this.turnStartedAt;
      // Rides with the event that ends the turn, so a client that joined mid-turn prints
      // the host's span rather than the sliver it watched from its own clock. Copied, not
      // mutated: capEvent hands back the adapter's own object when it has nothing to trim.
      data = { ...data, turnMs: this.lastTurnMs };
    }
    const childEvent = CHILD_EVENTS[event];
    const wire = data?.parentToolUseId && childEvent ? { event: childEvent, data } : { event, data };

    // The harness writes an `attachment` for what it put INTO the conversation — a hook's
    // output, a prompt waiting its turn — and stream-json never sends one, so the live pane
    // could only ever see them after a reload. Read the tail it appended, ONCE per turn:
    // the file is append-only, so it costs one small read (measured 0.014ms).
    //
    // Pulled BEFORE assigning this record's seq. Emitted inside _pullAttachments, those
    // records take earlier seqs than `turn_complete`, so the client applies them in order
    // and never drops the turn's ending as an "already applied" lower seq.
    if (TURN_END_EVENTS.has(event)) this._pullAttachments();

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
    // Only a RECORDED event carries its seq onto the wire. The client drops anything at
    // or below its watermark, and an unrecorded event's number is not in the log the
    // watermark is compared against — a live event stamped past the snapshot would be
    // swallowed on the next hydrate.
    // The chat's own sign of life, for the idle watchdog.
    //
    // `getLastOutputAt` is stamped by the PTY on every chunk, and a chat session HAS no
    // PTY — so that reading stayed 0 ("never") and `quietFor` was the whole age of the
    // process. Every chat turn therefore looked stalled from birth, and the watchdog
    // SIGINTed a CLI that was working normally. A record arriving from the adapter IS
    // this session's output; stamping here is what makes the two comparable.
    touchOutput(this.id);
    this.onEvent?.(this.id, wire.event, data, record ? seq : undefined);
    if (record) this.scheduleSaveSnapshot();

    // Work that outlives the turn it was launched in.
    //
    // The CLI states a task's end itself (`task_notification`), so that is what disarms
    // the clock: the record's `tool_use_id` is the call the pane's row is keyed by.
    // `asyncHandle`'s regex only arms the clock for a CLI too old to emit task records,
    // or an engine that hands work off without ever naming it again (codex, antigravity).
    if (event === "cli_event" && data?.subtype === "task_notification") {
      const toolUseId = data.record?.tool_use_id;
      if (toolUseId) this.clearAsyncWatchdog(toolUseId);
    }
    if (event === "tool_result") {
      if (data?.async && data?.handle) this.armAsyncWatchdog(data.id, data.parentToolUseId);
      else if (data?.id) this.clearAsyncWatchdog(data.id);
    }

    // Any terminal event releases the turn. Missing `error`/`exit` from that set left the
    // flag stuck true after a failed spawn, and the ack hands that flag to every client —
    // so the pane came back from an F5 spinning on a process that was already gone.
    if (TURN_END_EVENTS.has(event)) {
      this.isTurnRunning = false;
      this.history = compactEvents(this.history);
      this.flushSaveSnapshot();
      this.applyPendingOptions();
    }
  }

  /**
   * Emit any attachment the harness appended since the last read.
   *
   * Called at a turn boundary: by then the harness has written the turn's records, so one
   * read catches them all. Failure is silent on purpose — this is a side channel to the
   * transcript, and a pane must not lose a turn because a read of someone else's file
   * failed.
   */
  _pullAttachments() {
    if (this.engine !== AI_ENGINES.CLAUDE || !this.cliSessionId || this.destroyed) return;
    if (this.attachmentOffset == null) {
      // First read of a session: adopt the file's current end so only what comes AFTER
      // this point is news. See the constructor.
      const seeded = this._seedAttachmentOffset
        ? this._seedAttachmentOffset()
        : readNewAttachments(this.cwd, this.cliSessionId, Infinity);
      this.attachmentOffset = seeded?.offset || 0;
      return;
    }
    const read = this._readAttachments
      ? this._readAttachments()
      : readNewAttachments(this.cwd, this.cliSessionId, this.attachmentOffset);
    if (!read?.records?.length) {
      if (read?.offset != null) this.attachmentOffset = read.offset;
      return;
    }
    this.attachmentOffset = read.offset;
    for (const record of read.records) {
      this.emitNormalized("cli_event", {
        type: "attachment",
        subtype: record.attachment?.type || "",
        record
      });
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
  /**
   * The turn's own watchdog does not cover work that outlives it. A sub-agent or a
   * background shell keeps running after `turn_complete`, and nothing in the CLI ever
   * reports its end — so without a clock of its own the row would spin until the chat was
   * reloaded. Same window and the same shape as `armIdleWatchdog`, one level down.
   *
   * The event that ends a turn does NOT settle these rows: the launch ack already said
   * the work is out of the turn's hands. Keyed by tool id, not by handle, because the
   * client nests a sub-agent's rows under its own id.
   */
  armAsyncWatchdog(toolId, parentToolUseId) {
    if (!toolId) return;
    this.clearAsyncWatchdog(toolId);
    this.asyncTimers.set(toolId, setTimeout(() => {
      this.asyncTimers.delete(toolId);
      // Recorded, not transient: a client that joins after the work ended must still see
      // the row settled, or a reload leaves it spinning forever.
      this.emitNormalized("tool_result", {
        id: toolId,
        status: "done",
        async: true,
        ...(parentToolUseId ? { parentToolUseId } : {})
      });
    }, AI_ASYNC_IDLE_TIMEOUT_MS));
  }

  clearAsyncWatchdog(toolId) {
    const timer = this.asyncTimers.get(toolId);
    if (!timer) return;
    clearTimeout(timer);
    this.asyncTimers.delete(toolId);
  }

  clearAllAsyncWatchdogs() {
    for (const timer of this.asyncTimers.values()) clearTimeout(timer);
    this.asyncTimers.clear();
  }

  /**
   * Settle every `async` row a restored log left open.
   *
   * Called on both log sources, and after the transcript overwrite — `_rebuildFromStore`
   * replaces this.history wholesale, so a pass over the snapshot alone would miss exactly
   * the chats that have a transcript to rebuild from.
   *
   * The turn that launched this work is long over, and nothing survived that could report
   * on it. A row is only ever closed once, so a second pass over an unchanged log is a
   * no-op.
   */
  _settleRestoredAsync() {
    for (const ev of this.history || []) {
      if (ev.event !== "tool_result" || !ev.data?.async || ev.data.status !== "running") continue;
      ev.data = { ...ev.data, status: "done" };
    }
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
      // The turn whose span the pane was printing belongs to the conversation this
      // clears, so the summary goes with it.
      this.turnStartedAt = 0;
      this.lastTurnMs = 0;
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
      this.onEvent?.(this.id, "conversation_reset", {
        hasMore: false, fromSeq: 0,
        lastTurnMs: 0, isTurnRunning: false, elapsedMs: 0
      });
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
      // show one conversation while the CLI continues another. Same one door as every
      // other rebuild — a hydrate, the constructor, a gap and a rewind all come here.
      this._adoptLog(this._rebuildFromStore(resume) || []);
      // A different conversation: the span of the turn this session ran belongs to the
      // log that just went, and would print under the resumed chat as its own summary.
      this.turnStartedAt = 0;
      this.lastTurnMs = 0;
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
    this.clearAllAsyncWatchdogs();
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
