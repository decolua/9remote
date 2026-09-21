import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AI_ENGINES, AI_TURN_IDLE_TIMEOUT_MS, AI_ASYNC_IDLE_TIMEOUT_MS, AI_DOCTOR_TIMEOUT_MS, AI_PERSIST_DEBOUNCE_MS, AI_PERSIST_STREAM_MS, AI_MAX_EVENTS, AI_MAX_TOOL_OUTPUT, AI_TASK_RECORDS_BYTES } from "./constants.js";
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
import { OmpAdapter } from "./adapters/ompAdapter.js";
import { attachmentMeta } from "./aiAttachment.js";
import { getLastOutputAt, touchOutput, OUTPUT_LIVE_WINDOW_MS } from "../terminal/statusManager.js";
import { TURN_END_EVENTS } from "./aiStatus.js";
import { saveAiPreference } from "./models.js";
import { PATHS } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("ai");

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;
const stripAnsi = (text) => String(text || "").replace(ANSI_RE, "");

// Engines whose CLI the daemon owns, so a turn outlives an agent restart.
const MANAGED_ENGINES = new Set([AI_ENGINES.CLAUDE, AI_ENGINES.CODEX, AI_ENGINES.OPENCODE, AI_ENGINES.ANTIGRAVITY, AI_ENGINES.OMP]);

// Engine → the CLI's own health command, from each adapter's static spec; a Map so an engine id like "constructor" cannot hit Object.prototype.
const DOCTOR_SPECS = new Map(
  Object.entries({
    [AI_ENGINES.CLAUDE]: ClaudeAdapter,
    [AI_ENGINES.CODEX]: CodexAdapter,
    [AI_ENGINES.OPENCODE]: OpenCodeAdapter,
    [AI_ENGINES.ANTIGRAVITY]: AntigravityAdapter,
    [AI_ENGINES.OMP]: OmpAdapter
  }).map(([engine, Adapter]) => [engine, Adapter.doctorSpec?.() || null])
);

// Spawns only the doctor command itself — never an AI session.
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
      // Doctor output carries ANSI colour codes; the UI renders this as plain text.
      const clean = stripAnsi(out || err);
      if (code !== 0 && !clean) return resolve({ ok: false, error: `${spec.command} doctor exited with code ${code}` });
      resolve({ ok: true, output: clean, version: "" });
    });
  });
}

// Follows the agent's own root, so a relocated or test instance keeps its conversations to itself.
const AI_SESSIONS_DIR = PATHS.AI_SESSIONS;
try { if (!fs.existsSync(AI_SESSIONS_DIR)) fs.mkdirSync(AI_SESSIONS_DIR, { recursive: true }); } catch {}

// Every engine owns its snapshot here; ponytail: legacy prefix-less daemon snapshots are left behind for a later cleanup.
function aiSnapshotFile(sessionId, engine) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(AI_SESSIONS_DIR, `${engine}-${safe}.json`);
}

function loadSessionSnapshot(sessionId, engine) {
  try {
    const raw = fs.readFileSync(aiSnapshotFile(sessionId, engine), "utf8");
    const snap = JSON.parse(raw);
    // No `events` requirement — the log is no longer stored here; older files carrying it still load.
    if (!snap || snap.engine !== engine) return null;
    return snap;
  } catch {
    return null;
  }
}

// Sub-agent tool events, renamed on the wire so the client nests rather than appends them.
const CHILD_EVENTS = { tool_start: "tool_child", tool_result: "tool_result_child" };

// CLI streams these but never writes them down; recorded, they crowded out the whole replay window.
const LIVE_ONLY_CLI_SUBTYPES = new Set([
  "thinking_tokens",
  "tool_progress",
  "hook_started",
  "hook_progress",
  "hook_response",
  "status",
  "control_response"
]);

// Same rule for codex records (spelled as a method); codex writes none of them to its rollout.
const LIVE_ONLY_CLI_TYPES = new Set([
  "hook/started",
  "hook/completed",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "mcpServer/startupStatus/updated",
  "mcpServer/event/stream/notification",
  "mcpServer/oauthLogin/completed",
  "account/rateLimits/updated",
  "remoteControl/status/changed",
  "thread/status/changed",
  "model/safetyBuffering/updated",
  "turn/moderationMetadata",
  "fs/changed",
  "process/outputDelta",
  "process/exited"
]);

// Client-supplied resume id: no leading "-" (argv would read it as a flag), no path or whitespace — rejected before it reaches the CLI.
const RESUME_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

// Human labels adapters default metadata.model to — never valid model ids (see emitNormalized).
const MODEL_LABELS = new Set(["codex default", "opencode default"]);

// Cap what ONE event contributes — a replay window is one wire frame, so a single unbounded payload costs the client its history. Copy-on-write so per-token deltas allocate nothing.
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

// Drop `rendered` and `attachment.snippet`: the pane never reads them and together they were 30% of a real log.
function slimAttachment(record) {
  if (!record?.attachment) return record;
  if (record.rendered === undefined && record.attachment.snippet === undefined) return record;
  const { rendered, attachment, ...rest } = record;
  if (attachment.snippet === undefined) return { ...rest, attachment };
  const { snippet, ...body } = attachment;
  return { ...rest, attachment: body };
}

// The one door every event takes into the log, so snapshot-loaded events are capped too; the skip list is a perf guard only.
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

// The client's own skip wording, so both doors read the same to the CLI.
const SKIP_BEHAVIOR = "deny";
const SKIP_MESSAGE = "User skipped this request";

// Snapshot seqs can repeat or run backwards; the client's scroll-up stops at the first one, so renumber on load.
function renumber(events) {
  return (events || []).map((ev, i) => (ev.seq === i + 1 ? ev : { ...ev, seq: i + 1 }));
}

// Idempotent cap over snapshot-loaded events whose payloads predate capEvent.
function capLog(events) {
  return (events || []).map((ev) => {
    const data = capEvent(ev.event, ev.data);
    return data === ev.data ? ev : { ...ev, data };
  });
}

// The only cli_event subtypes the CLI never writes to its own transcript — carried across rebuilds or the task strip is lost.
const CARRIED_CLI_SUBTYPES = new Set([
  "task_started", "task_updated", "task_notification", "background_tasks_changed"
]);

const isCarriedRecord = (ev) => ev.event === "cli_event" && CARRIED_CLI_SUBTYPES.has(ev.data?.subtype);

// Carried records paired with the index they sat at.
const cliEventsOf = (events) =>
  (events || []).map((e, i) => ({ e, i })).filter(({ e }) => isCarriedRecord(e));

function mergeCarried(carried, events) {
  return carried.length ? insertByIndex(events, carried) : events;
}

// Fold consecutive delta/thinking slices into one record; the log is a cache that only loses content.
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

// The rebuilt log is shorter, so position each carried record by how many live events preceded it, never by raw index.
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

const kvKey = (id) => `ai:${id}`;
let queueIdSeq = 0;

export class AiSession {
  constructor({ id, engine, cwd, options = {}, onEvent }) {
    this.id = id;
    this.engine = engine;
    this.cwd = cwd || process.cwd();
    this.options = options;
    this.onEvent = onEvent;
    this.createdAt = Date.now();
    this.isTurnRunning = false;
    this.promptQueue = [];
    this._drainTimer = null;
    // Async watchdogs by tool id; ponytail: fallback only — task_* records disarm them on newer CLIs.
    this.asyncTimers = new Map();
    // A span, not timestamps — the client's clock is a different clock, and subtracting across them would print the skew.
    this.turnStartedAt = 0;
    this.lastTurnMs = 0;
    this.lastPrompt = "";
    this.adapter = null;
    // In-flight goal read (shared by concurrent inits) and last emitted key (reconnects do not re-append).
    this.goalReading = null;
    this.goalKey = null;

    const snap = loadSessionSnapshot(id, engine);
    // Caller options win; snapshot picks survive the restart that lost this RAM copy.
    this.options = { ...(snap?.options || {}), ...options };
    // Byte offset into the append-only transcript; a first read starts at the file's current end, not zero.
    this.attachmentOffset = snap?.attachmentOffset ?? null;
    // Not born here: start() decides between spawning and adopting the daemon's live process.
    this.proc = MANAGED_ENGINES.has(engine) ? new DaemonProc({ procId: id }) : null;
    // Lines already parsed into this log, so a re-attach fetches only the rest.
    this.consumedLines = snap?.consumedLines || 0;
    // Line numbers belong to a process; null (legacy snapshot) makes the first adopt replay the turn whole.
    this.consumedEpoch = snap?.consumedEpoch ?? null;
    this.ready = null;
    // cliSessionId is client-supplied and becomes CLI argv, so it is validated like `resume` — a leading "-" would be read as a flag.
    const requestedId = typeof options.cliSessionId === "string" && RESUME_ID_RE.test(options.cliSessionId)
      ? options.cliSessionId
      : null;
    const bindId = snap?.threadId || snap?.cliSessionId || requestedId || options.threadId || options.sessionId || null;
    this.threadId = engine === AI_ENGINES.CODEX ? bindId : null;
    this.cliSessionId = engine === AI_ENGINES.CODEX ? null : bindId;
    // Rebuilt from the CLI's own store below — the snapshot no longer carries the log.
    this.history = [];
    // Merged, not overwritten — a rebuild cannot reproduce the harness's own task records.
    if (bindId) {
      const rebuilt = this._rebuildFromStore(bindId);
      if (rebuilt) this.history = mergeCarried(cliEventsOf(this.history), rebuilt);
    }
    // Restored async rows have no live watchdog left; settle them or they spin forever.
    this._settleRestoredAsync();
    // Seeded from the log so pre-counter snapshots still continue upward.
    this.seqCounter = this.history.at(-1)?.seq || 0;
    // Snapshot write in flight / coalesced, so a streaming turn does not re-serialize on every delta.
    this.persisting = false;
    this.persistAgain = false;
    this.persistTimer = null;
    this.model = snap?.model || options.model || options.defaultModel || "";
    // Empty means the CLI's own config decides; the composer reads that instead of showing an unchosen level.
    this.effort = snap?.effort || options.effort || options.defaultEffort || (this.engine === AI_ENGINES.CODEX ? "xhigh" : "");
    // Restored so a reload re-sends the user's mode — turn-per-CLI engines need it on every prompt.
    this.permissionMode = snap?.permissionMode || options.mode || options.defaultMode || null;
    // The harness's own transcript records beat 9Remote's reconstruction — override, not merge.
    if (this.engine === AI_ENGINES.CLAUDE && bindId) {
      const state = readClaudeSessionState(this.cwd, bindId);
      if (state) {
        if (state.permissionMode) this.permissionMode = state.permissionMode;
        if (state.lastPrompt) this.lastPrompt = state.lastPrompt;
        // NOT state.cwd: the transcript's cwd is where the CLI started; this.cwd is where its process runs.
        if (state.cwd) this.harnessCwd = state.cwd;
        if (state.isWorktree) this.isWorktree = true;
        // The harness's own title, for the history list and terminals that follow the chat's name.
        if (state.title) this.harnessTitle = state.title;
      }
    }
    // Discovered at connect time by aiSocket; kept so a cleared log can be re-seeded.
    this.skills = [];

    if (!options.mock) {
      this.ready = this.initAdapter();
      this._restoreFromDaemonKv();
    }
  }

  _saveKvState(running = this.isTurnRunning) {
    if (!daemonClient.isConnected()) return;
    daemonClient.kvSet(kvKey(this.id), {
      engine: this.engine,
      stats: this.adapter?.stats || null,
      turn: {
        running,
        startedAt: this.turnStartedAt || null,
        lastTurnMs: this.lastTurnMs || 0
      },
      lastPrompt: this.lastPrompt || "",
      threadTitle: this.threadTitle || "",
      carried: cliEventsOf(this.history),
      // The user's own picks, so a session rehydrates as the chat it was even when the
      // snapshot file is gone. Fill-if-empty on the way back in (see _restoreFromDaemonKv).
      permissionMode: this.permissionMode || null,
      model: this.model || "",
      effort: this.effort || "",
      cwd: this.cwd,
      cliSessionId: this.cliSessionId || null,
      threadId: this.threadId || null,
      options: this.options || {},
      consumedLines: this.consumedLines || 0,
      consumedEpoch: this.consumedEpoch ?? null,
      // The gate the CLI holds right now: an agent death mid-gate would otherwise lose it,
      // because the control_request that opened it sits before the adopt watermark.
      pendingPermission: this.pendingPermission?.() || null
    }).catch(() => {});
  }

  // The turn marker is a vote, not a verdict — it only counts beside a process the daemon still holds.
  async _restoreFromDaemonKv() {
    if (!daemonClient.isConnected()) return;
    try {
      const saved = await daemonClient.kvGet(kvKey(this.id));
      if (!saved) return;
      if (saved.stats && this.adapter?.stats) {
        // Only untouched counters take the value — a late read must not walk back a replayed turn.
        for (const [k, v] of Object.entries(saved.stats)) {
          if (typeof v === "number" && !this.adapter.stats[k]) this.adapter.stats[k] = v;
        }
      }
      if (saved.lastPrompt && !this.lastPrompt) {
        this.lastPrompt = saved.lastPrompt;
      }
      if (saved.threadTitle && !this.threadTitle) {
        this.threadTitle = saved.threadTitle;
      }
      // The user's own picks, fill-if-empty: the snapshot file and the client's create
      // options are the primary doors; this one answers when both came up empty.
      if (saved.permissionMode && !this.permissionMode) {
        this.permissionMode = saved.permissionMode;
        // Claude holds ONE process and it is already adopted by now, so the mode goes
        // onto the adapter too or the next respawn speaks the old one. Codex/opencode
        // keep theirs in a `permissionMode` field instead, read per spawned turn.
        if (this.adapter?.currentMode === "default") this.adapter.currentMode = saved.permissionMode;
        if (this.adapter && this.adapter.permissionMode === "default") this.adapter.permissionMode = saved.permissionMode;
      }
      if (saved.model && !this.model) {
        this.model = saved.model;
        if (this.adapter?.metadata && !this.adapter.metadata.model) this.adapter.metadata.model = saved.model;
      }
      if (saved.effort && !this.effort) {
        this.effort = saved.effort;
        if (this.adapter && !this.adapter.effort) this.adapter.effort = saved.effort;
      }
      if (saved.cwd && !this.cwd) this.cwd = saved.cwd;
      if (saved.cliSessionId && !this.cliSessionId) this.cliSessionId = saved.cliSessionId;
      if (saved.threadId && !this.threadId) this.threadId = saved.threadId;
      if (saved.options) this.options = { ...saved.options, ...this.options };
      // The line watermark is saved for diagnosis but NOT restored here: it belongs to
      // the adopt path, which owns the process it indexes — a restored one would make
      // the next attach replay lines from a process that no longer exists.
      if (saved.turn?.running) {
        let isAlive = false;
        if (this.engine === AI_ENGINES.OPENCODE) {
          try {
            const active = await this.adapter?.server?.activeSessions?.();
            isAlive = active?.[this.cliSessionId]?.type !== "idle";
          } catch {}
        } else {
          const held = await daemonClient.procList();
          const procs = Array.isArray(held) ? held : held?.procs;
          isAlive = (procs || []).some((proc) => (proc.procId === this.id || proc.id === this.id) && proc.alive !== false);
        }
        if (isAlive) {
          this.isTurnRunning = true;
          this.turnStartedAt = saved.turn.startedAt || Date.now();
          // The gate a dead agent left open: the control_request that opened it sits
          // before the adopt watermark, so the adapter's map came back empty. Put the
          // saved gate back or the pane has no card while the CLI waits forever.
          const gate = saved.pendingPermission;
          if (gate?.requestId != null && this.adapter?.pendingRequests && !this.adapter.pendingRequests.size) {
            this.adapter.pendingRequests.set(gate.requestId, { toolName: gate.tool || "", input: gate.input || {} });
          }
        }
      }
      if (Array.isArray(saved.carried) && saved.carried.length) {
        const existingIds = new Set(this.history.map((e) => e.data?.record?.task_id || e.data?.id).filter(Boolean));
        const missing = saved.carried
          .map((item, idx) => (item?.e ? item : { e: item, i: idx }))
          .filter(({ e }) => {
            const id = e?.data?.record?.task_id || e?.data?.id;
            return !id || !existingIds.has(id);
          });
        if (missing.length) {
          this.history = renumber(mergeCarried(missing, this.history));
          this.seqCounter = this.history.length;
        }
      }
    } catch {
      // The KV is a cache; transcripts remain the authority.
    }
  }

  initAdapter() {
    // Handlers bind to the adapter that owns them and stand down once a newer one replaces it.
    let mine = null;
    const onEvent = (event, data) => {
      if (this.adapter !== mine) return;
      this.emitNormalized(event, data);
    };
    // Only claude is spawned with a mode; the rest map it through setOptions.
    const mode = this.permissionMode || this.options.mode || "default";

    switch (this.engine) {
      case AI_ENGINES.CLAUDE:
        mine = new ClaudeAdapter({ cwd: this.cwd, onEvent, proc: this.managed ? this.proc : null, hostSessionId: this.id });
        this.adapter = mine;
        // Set BEFORE start(): setOptions would restart the CLI and spawn a second process.
        if (this.model) mine.metadata.model = this.model;
        if (this.effort) mine.effort = this.effort;
        // adopt() re-seeds from currentMode; without this a re-attach resets the mode to
        // the constructor's "default" and a Yolo session starts asking for permission.
        mine.currentMode = mode;
        return this._startManaged(mine, mode);
      case AI_ENGINES.CODEX:
        mine = new CodexAdapter({
          cwd: this.cwd,
          onEvent,
          proc: this.managed ? this.proc : null,
          threadId: this.threadId,
          model: this.model || this.options.model,
          hostSessionId: this.id,
          // Caller's transport, not gated on `managed` — without a daemon the adapter makes its own proc.
          transport: this.options.transport || null
        });
        this.adapter = mine;
        // Re-sent on every rebuild — codex spawns fresh per turn.
        if (this.permissionMode || this.options.model || this.options.effort || this.effort || this.options.sandbox || this.options.flags) {
          mine.setOptions({ ...this.options, effort: this.effort || this.options.effort, mode: this.permissionMode || this.options.mode });
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
        // Through setOptions, not the field — it publishes effort on init and drops model-tier suffixes.
        if (this.permissionMode || this.options.model || this.options.flags || this.effort) {
          mine.setOptions({ ...this.options, effort: this.effort || this.options.effort, mode: this.permissionMode || this.options.mode });
        }
        return this._startManaged(mine, mode);
      case AI_ENGINES.OMP:
        mine = new OmpAdapter({
          cwd: this.cwd,
          onEvent,
          proc: this.managed ? this.proc : null,
          sessionId: this.cliSessionId,
          model: this.model || this.options.model,
          hostSessionId: this.id
        });
        this.adapter = mine;
        if (this.permissionMode || this.options.model || this.effort) {
          mine.setOptions({ ...this.options, effort: this.effort || this.options.effort, mode: this.permissionMode || this.options.mode });
        }
        return this._startManaged(mine, mode);
      default:
        throw new Error(`Unsupported engine: ${this.engine}`);
    }
  }

  // The daemon holds the CLI, so a turn outlives an agent restart.
  get managed() {
    return MANAGED_ENGINES.has(this.engine) && daemonClient.isConnected();
  }

  async _startManaged(adapter, mode) {
    // A process already running under this id IS this chat's turn — adopt it, never spawn a second writer.
    if (this.managed) {
      const attached = await adapter.adopt(this.consumedLines, this.consumedEpoch);
      if (attached.alive || attached.lines?.length) {
        this.adopted = true;
        // The session's copy gates spawn-time options from restarting the CLI mid-answer.
        if (adapter.isTurnRunning) this.isTurnRunning = true;
        this._replay(attached);
        return attached;
      }
    }
    // Nothing to adopt: a new process, so its line numbering and the watermark start over.
    this.adopted = false;
    this.consumedLines = 0;
    this.consumedEpoch = null;
    // Turn-per-CLI engines idle between turns; asking the adapter (not the engine) survives transport swaps.
    if (!adapter.persistent && this.engine !== AI_ENGINES.CLAUDE) return null;
    const fetch = await adapter.start(mode, this.cliSessionId || this.threadId);
    this._replay(fetch);
    return fetch;
  }

  // Feed fetched lines in order, then let live ones through; the watermark advances only past what was parsed.
  _replay(fetch) {
    if (!fetch) return;
    // How many lines the daemon's ring dropped while no agent watched; the gap is filled below.
    this.lastMissed = fetch.missed || 0;
    if (fetch.missed > 0) this._fillGap(fetch.missed);
    // commit() decodes on the way in, so callers need not know live string vs fetched b64 record.
    fetch.commit?.((line) => this.adapter.feed(line));
    // The watermark is honest only after release() fed the held lines; the epoch marks which process numbered them.
    this.consumedLines = this.proc?.lineNo || 0;
    this.consumedEpoch = this.proc?.epoch ?? null;
  }

  // The one place a transcript becomes a log — the transcript is the authority, so always rebuild instead of testing whether the log looks thin.
  _rebuildFromStore(sessionId, leafOverride = null) {
    // The id reaches argv and the filesystem; each reader validates it (see RESUME_ID_RE).
    const recovered = recoverFromTranscript(this.engine, this.cwd, sessionId, leafOverride);
    return recovered?.length ? renumber(capLog(recovered)) : null;
  }

  // Rebuild and reset every client before the hydrate is answered, so the ack's window covers everything.
  refreshFromStore() {
    if (!this.cliSessionId) return false;
    const log = this._rebuildFromStore(this.cliSessionId);
    if (!log) return false;
    this._adoptLog(log);
    return true;
  }

  // A rewind shortened the CLI's own store; rebuild + reset or clients keep rendering the discarded turns.
  reloadFromStore(leafOverride = null) {
    if (!this.cliSessionId) return false;
    // Without leafOverride the file is read in the ~50ms before the CLI writes the new pointer, so the pre-cut branch comes back.
    const log = this._rebuildFromStore(this.cliSessionId, leafOverride);
    if (!log) return false;
    this._adoptLog(log);
    return true;
  }

  _adoptLog(events) {
    // Replace with what the transcript reconstructs, but carry the harness-only records across at their old positions — never re-emit them.
    const merged = mergeCarried(cliEventsOf(this.history), events);
    // From 1, and the counter restarts — else the next live event carries the dead log's seq and is dropped.
    const log = renumber(capLog(merged));
    this.seqCounter = log.length;
    this.history = log;
    // Same window door as the hydrate ack — steps over events too wide for one frame.
    const { events: replay, hasMore, fromSeq } = replayWindow(log, AI_REPLAY_BYTES);
    // Turn state rides with the reset, matching the hydrate ack so either arrival order agrees.
    this.onEvent?.(this.id, "conversation_reset", {
      hasMore, fromSeq,
      lastTurnMs: this.lastTurnMs,
      taskRecords: this.taskRecords(),
      ...this.turnState()
    });
    for (const ev of replay) {
      // replay: true marks history so the status mirror stands down; the pane still consumes each one.
      this.onEvent?.(this.id, ev.event, { ...ev.data, replay: true }, ev.seq);
    }
    this.flushSaveSnapshot();
    return log;
  }

  // The CLI's own transcript is not bounded by the daemon's buffer, so a gap is recoverable from it.
  _fillGap(missed) {
    if (this.cliSessionId && this.refreshFromStore()) return;
    // Nothing to rebuild from — a visible gap beats a silent skip.
    this.emitNormalized("ansi", {
      chunk: `\r\n[9remote] ${missed} dòng output đã mất trong lúc agent khởi động lại.\r\n`
    });
  }

  // elapsedMs is a duration, not a mark — the two machines sit on different clocks.
  turnState() {
    return {
      isTurnRunning: this.isTurnRunning,
      elapsedMs: this.isTurnRunning && this.turnStartedAt ? Date.now() - this.turnStartedAt : 0
    };
  }

  // Task records ride with the state, not the log — the replay window misses them; raw (one pane reader), bounded to one SCTP frame, newest first.
  taskRecords() {
    const out = [];
    let bytes = 0;
    const now = Date.now();
    for (let i = this.history.length - 1; i >= 0; i--) {
      const ev = this.history[i];
      if (!isCarriedRecord(ev)) continue;
      const data = { ...ev.data, ageMs: now - (ev.timestamp || now) };
      const size = JSON.stringify(data).length;
      if (bytes + size > AI_TASK_RECORDS_BYTES) break;
      bytes += size;
      out.push(data);
    }
    return out.reverse();
  }

  emitNormalized(event, data, record = true) {
    // A record the harness itself does not keep is not history — see LIVE_ONLY_CLI_SUBTYPES.
    if (record && event === "cli_event" && LIVE_ONLY_CLI_SUBTYPES.has(data?.subtype)) record = false;
    if (record && event === "cli_event" && LIVE_ONLY_CLI_TYPES.has(data?.type)) record = false;
    if (event === "init") {
      if (data?.threadId) this.threadId = data.threadId;
      // A DIFFERENT conversation drops the byte offset — it indexes one transcript file; the same id keeps it.
      if (data?.sessionId && data.sessionId !== this.cliSessionId) {
        this.attachmentOffset = null;
        // Drop the old conversation's title too, or the tab keeps it after /clear.
        this.threadTitle = "";
      }
      if (data?.sessionId) this.cliSessionId = data.sessionId;
      // Only a real model id may be remembered — a human label sent back as -m 404s the provider.
      if (data?.model && !MODEL_LABELS.has(data.model)) this.model = data.model;
      if (data?.effort) this.effort = data.effort;
      // The goal RPC keys on the thread id, which changes with a resume — re-read each init.
      if (this.engine === AI_ENGINES.CODEX && data?.threadId) this.refreshGoal(data.threadId);
      // The server's own thread name; the rollout-file reader only ever sees the first prompt.
      if (data?.threadName) {
        this.threadTitle = String(data.threadName).trim();
        this._saveKvState();
      }
    }
    // Sub-agent tool calls become tool_child so the replay rebuilds the parent nesting.
    data = capEvent(event, data);
    // ageMs keeps task clocks comparable across the two machines' clocks.
    if (event === "cli_event" && CARRIED_CLI_SUBTYPES.has(data?.subtype)) {
      data = { ...data, ageMs: 0 };
      this._saveKvState();
    }
    // Stamped on the way out so every turn-ending writer is covered once.
    const now = Date.now();
    if (event === "user_message") {
      this.turnStartedAt = now;
      this.lastTurnMs = 0;
    } else if (TURN_END_EVENTS.has(event)) {
      if (this.turnStartedAt) this.lastTurnMs = now - this.turnStartedAt;
      // Copied, not mutated — capEvent may hand back the adapter's own object.
      data = { ...data, turnMs: this.lastTurnMs };
    }
    const childEvent = CHILD_EVENTS[event];
    const wire = data?.parentToolUseId && childEvent ? { event: childEvent, data } : { event, data };

    // stream-json never sends attachments — pulled before the seq so their records sort before the turn's end.
    if (TURN_END_EVENTS.has(event)) this._pullAttachments();
    // /goal lands in the CLI's state during the turn — read it at the turn's end.
    if (TURN_END_EVENTS.has(event) && this.engine === AI_ENGINES.CODEX && this.threadId) {
      this.refreshGoal(this.threadId);
    }

    // A counter, never the array length — compaction and the cap shrink the log and a length-derived seq went backwards.
    const seq = ++this.seqCounter;
    // record=false broadcasts without logging — per-connect metadata must not accumulate on every F5.
    if (record) {
      this.history.push({ seq, event: wire.event, data, timestamp: Date.now() });
      if (this.history.length > AI_MAX_EVENTS) this.history.shift();
    }
    // Unrecorded events carry no seq — the client's watermark only knows recorded ones.
    // Chats have no PTY, so without this stamp the idle watchdog sees every turn as stalled from birth.
    touchOutput(this.id);
    this.onEvent?.(this.id, wire.event, data, record ? seq : undefined);
    if (record) this.scheduleSaveSnapshot();

    // The CLI's own task-end record is what disarms an async clock (keyed by tool_use_id).
    if (event === "cli_event" && data?.subtype === "task_notification") {
      const toolUseId = data.record?.tool_use_id;
      if (toolUseId) this.clearAsyncWatchdog(toolUseId);
    }
    if (event === "tool_result") {
      if (data?.async && data?.handle) this.armAsyncWatchdog(data.id, data.parentToolUseId);
      else if (data?.id) this.clearAsyncWatchdog(data.id);
    }

    // Any terminal event releases the turn, or a failed spawn leaves every client spinning.
    if (TURN_END_EVENTS.has(event)) {
      this.isTurnRunning = false;
      this.history = compactEvents(this.history);
      this.flushSaveSnapshot();
      this.applyPendingOptions();
      this._saveKvState(false);
      this._drainQueue();
    }
  }

  _drainQueue() {
    if (this.isTurnRunning || !this.promptQueue?.length || this.destroyed) return;
    if (this._drainTimer) clearTimeout(this._drainTimer);
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      if (this.isTurnRunning || !this.promptQueue?.length || this.destroyed) return;
      const next = this.promptQueue.shift();
      this.emitQueueUpdate();
      this.sendPrompt(next.text, next.attachments);
    }, 50);
  }

  getQueue() {
    if (!Array.isArray(this.promptQueue)) return [];
    return this.promptQueue.map((item) => ({
      id: item.id,
      text: item.text,
      attachments: (item.attachments || []).map((a) => ({ name: a.name || a.filename, type: a.type }))
    }));
  }

  emitQueueUpdate() {
    this.onEvent?.(this.id, "queue_update", { queue: this.getQueue() });
  }

  removeQueueItem(id) {
    if (!Array.isArray(this.promptQueue)) return false;
    const before = this.promptQueue.length;
    this.promptQueue = this.promptQueue.filter((item) => item.id !== id);
    if (this.promptQueue.length !== before) {
      this.emitQueueUpdate();
      return true;
    }
    return false;
  }

  clearQueue() {
    if (this._drainTimer) { clearTimeout(this._drainTimer); this._drainTimer = null; }
    if (!this.promptQueue?.length) return;
    this.promptQueue = [];
    this.emitQueueUpdate();
  }

  // One read per turn boundary catches the harness's appended records; failure is silent on purpose (side channel).
  _pullAttachments() {
    if (this.engine !== AI_ENGINES.CLAUDE || !this.cliSessionId || this.destroyed) return;
    if (this.attachmentOffset == null) {
      // First read: adopt the file's current end so only what comes after is news.
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

  hasRecordedInit() {
    return this.history.some((e) => e.event === "init");
  }

  // Codex's /goal lives in its state DB and only surfaces over the app-server — hence its own event.
  async refreshGoal(threadId) {
    if (this.engine !== AI_ENGINES.CODEX || this.goalReading === threadId) return;
    this.goalReading = threadId;
    const goal = await readThreadGoal(threadId, this.cwd).catch(() => null);
    this.goalReading = null;
    // A stale read (the thread moved on) must not stamp its goal over the current one.
    if (this.threadId !== threadId) return;
    const key = goal ? `${goal.objective}|${goal.status}` : "";
    // Compared against the log too — init fires on every connect and would re-append unchanged goals.
    if (key === this.goalKey || key === this.lastRecordedGoalKey()) return;
    this.goalKey = key;
    // Always record a clearing — a late joiner must see there is no goal.
    this.emitNormalized("goal", { goal });
  }

  // Key of the newest recorded goal; "" means the last record was a clearing.
  lastRecordedGoalKey() {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].event !== "goal") continue;
      const g = this.history[i].data?.goal;
      return g ? `${g.objective}|${g.status}` : "";
    }
    return null;
  }

  // Covers async work that outlives its turn and never reports its end; keyed by tool id (the client nests rows by it).
  armAsyncWatchdog(toolId, parentToolUseId) {
    if (!toolId) return;
    this.clearAsyncWatchdog(toolId);
    this.asyncTimers.set(toolId, setTimeout(() => {
      this.asyncTimers.delete(toolId);
      // Recorded, so a late joiner sees the row settled.
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

  // Restored async rows have nothing left to report their end; closing twice is a no-op.
  _settleRestoredAsync() {
    for (const ev of this.history || []) {
      if (ev.event !== "tool_result" || !ev.data?.async || ev.data.status !== "running") continue;
      ev.data = { ...ev.data, status: "done" };
    }
  }

  // Debounced middle ground: a sync write per event stalls the socket, the turn boundary alone loses a hard kill.
  scheduleSaveSnapshot() {
    if (this.destroyed || this.persistTimer) return;
    // Long window while a turn streams (deltas fold at write); the boundary still flushes synchronously.
    const delay = this.isTurnRunning ? AI_PERSIST_STREAM_MS : AI_PERSIST_DEBOUNCE_MS;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.saveSnapshot();
    }, delay);
    this.persistTimer.unref?.();
  }

  // Turn boundaries pay a synchronous write: a crash right after one leaves a whole exchange intact.
  flushSaveSnapshot() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.saveSnapshot(true);
  }

  saveSnapshot(sync = false) {
    // Fold into the in-flight write — interleaved writes of a growing log can land out of order.
    if (this.persisting) { this.persistAgain = true; return; }
    this.persisting = true;
    try {
      // State only, never the log — the CLI's transcript and the daemon's ring already hold it.
      const payload = JSON.stringify({
        engine: this.engine,
        cwd: this.cwd,
        threadId: this.threadId,
        cliSessionId: this.cliSessionId,
        model: this.model,
        effort: this.effort,
        permissionMode: this.permissionMode,
        createdAt: this.createdAt,
        // The whole "user's own picks" family, kept whole.
        options: this.options,
        // Output-stream watermark + owning process, so a re-attached turn arrives whole and exactly once.
        consumedLines: this.consumedLines,
        consumedEpoch: this.consumedEpoch,
        // How far into the CLI's transcript this session has read.
        attachmentOffset: this.attachmentOffset
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
    // /clear is a host-side reset, not a message.
    if (String(prompt).trim() === "/clear") {
      // Refused mid-turn — rebuilding the adapter would kill the turn on screen.
      if (this.isTurnRunning) {
        this.emitNormalized("error", { message: "Turn is still running — stop it before /clear." });
        return;
      }
      // Drop the CLI conversation too, or the cleared chat resumes on the next restart.
      this.threadId = null;
      this.cliSessionId = null;
      this.history = [];
      // Counter restarts with the new log, or its first events read as already applied.
      this.seqCounter = 0;
      // A fresh process numbers its lines from scratch.
      this.consumedLines = 0;
      this.consumedEpoch = null;
      // The offset indexes one transcript file; left behind it would resume mid-record in the next one.
      this.attachmentOffset = null;
      this.isTurnRunning = false;
      // The old conversation's turn span goes with it.
      this.turnStartedAt = 0;
      this.lastTurnMs = 0;
      this.flushSaveSnapshot();
      if (!this.options.mock && !this.managed) {
        // Kill first — an adapter dropped without stop() leaves its CLI running; under the daemon there is nothing to rebuild.
        try { this.adapter?.stop(); } catch {}
        this.ready = this.initAdapter();
      }
      const init = this.metadata();
      this.history.push({ seq: ++this.seqCounter, event: "init", data: init, timestamp: Date.now() });
      this.onEvent?.(this.id, "conversation_reset", {
        hasMore: false, fromSeq: 0,
        // Empty and stated — silence keeps the old task set drawn.
        taskRecords: [],
        lastTurnMs: 0, isTurnRunning: false, elapsedMs: 0
      });
      this.onEvent?.(this.id, "init", init);
      this.clearQueue();
      this.flushSaveSnapshot();
      return;
    }

    // A new prompt ends every gate the old turn left open. The user typing IS them moving on.
    this.skipOpenGates();

    if (this.isTurnRunning) {
      if (!Array.isArray(this.promptQueue)) this.promptQueue = [];
      const item = {
        id: `q-${Date.now()}-${++queueIdSeq}`,
        text: prompt,
        attachments
      };
      this.promptQueue.push(item);
      this.emitQueueUpdate();
      return { queued: true, item };
    }

    this.lastPrompt = prompt;
    if (this.options.mock) {
      this.isTurnRunning = true;
      this.emitNormalized("user_message", { text: prompt, attachments: attachmentMeta(attachments) });
      this.emitNormalized("delta", { text: `[Mock reply to: ${prompt}]` });
      this.emitNormalized("turn_complete", { stats: {} });
      return;
    }
    // The adapter's busy-check first — a refused prompt must not log a turn nothing will answer.
    try {
      this.adapter?.sendPrompt(prompt, attachments);
    } catch (err) {
      this.emitNormalized("prompt_refused", { text: prompt, reason: String(err?.message || err) });
      if (this.promptQueue?.length) this._drainQueue();
      return;
    }
    this.isTurnRunning = true;
    this.turnStartedAt = Date.now();
    this._saveKvState(true);
    // A new prompt skips every open gate — only the host can answer a request the CLI holds.
    this.skipOpenGates();
    // Names only — the base64 never rides the replay log.
    this.emitNormalized("user_message", { text: prompt, attachments: attachmentMeta(attachments) });
  }

  // Restored from disk so a cleared session still names its model and skills before the CLI speaks.
  metadata() {
    return { model: this.model || "", threadId: this.threadId || "", sessionId: this.cliSessionId || "", skills: this.skills || [] };
  }

  // A replay window can drop the permission_request, so the open gate is restated here.
  pendingPermission() {
    // Newest wins, matching how a replay folds them.
    const map = this.adapter?.pendingRequests;
    if (!map?.size) return null;
    const requestId = [...map.keys()].at(-1);
    const req = map.get(requestId);
    return { requestId, tool: req.toolName || "", input: req.input || {} };
  }

  resolvePermission(requestId, behavior, message) {
    // Only an explicit false means refused — engines with no gate of their own return undefined.
    const handled = this.adapter?.resolvePermission?.(requestId, behavior, message);
    if (handled === false) return false;
    // Every client watching must drop its card too.
    this.emitNormalized("permission_resolved", { requestId, behavior });
    return true;
  }

  resolveQuestion(requestId, answers) {
    const handled = this.adapter?.resolveQuestion?.(requestId, answers);
    if (handled === false) return false;
    this.emitNormalized("permission_resolved", { requestId, behavior: "allow" });
    return true;
  }

  // Take the skip decision where the gate actually lives — the client can only skip the card it sees.
  skipOpenGates() {
    const map = this.adapter?.pendingRequests;
    if (!map?.size) return 0;
    let skipped = 0;
    for (const requestId of [...map.keys()]) {
      if (this.resolvePermission(requestId, SKIP_BEHAVIOR, SKIP_MESSAGE)) skipped++;
    }
    return skipped;
  }

  setOptions(opts) {
    // `resume` is one-shot: kept sticky, every later rebuild would re-bind the thread we just left.
    const { resume: rawResume, ...rest } = opts || {};
    // Client-supplied argv value — a leading "-" would be parsed as a flag (see RESUME_ID_RE).
    const resume = typeof rawResume === "string" && RESUME_ID_RE.test(rawResume) ? rawResume : null;
    this.options = { ...this.options, ...rest };
    // The session copy is what the snapshot stores.
    if (rest?.mode) this.permissionMode = rest.mode;
    if (rest?.effort) this.effort = rest.effort;
    if (rest?.model) this.model = rest.model;
    if (rest?.model || rest?.effort) {
      saveAiPreference(this.engine, { model: this.model, effort: this.effort });
    }
    // Resuming moves the session's own id, so a reload keeps talking to the resumed conversation.
    if (resume) {
      if (this.engine === AI_ENGINES.CLAUDE) this.cliSessionId = resume;
      else if (this.engine === AI_ENGINES.CODEX) this.threadId = resume;
      else if (this.engine === AI_ENGINES.OPENCODE) this.cliSessionId = resume;
      // Antigravity resumes by conversation id; the transcript reader fills the pane on reload.
      else if (this.engine === AI_ENGINES.ANTIGRAVITY) this.cliSessionId = resume;
      // Replace the log with the resumed conversation's tail; the old transcript's byte offset goes with it.
      this.attachmentOffset = null;
      this._adoptLog(this._rebuildFromStore(resume) || []);
      // The old conversation's turn span goes with it.
      this.turnStartedAt = 0;
      this.lastTurnMs = 0;
      if (!this.history.length) {
        logger.info(`[ai] rewind left an empty log: engine=${this.engine} resume=${resume} cwd=${this.cwd}`);
      }
    }
    // Spawn-time flags restart the CLI, which kills a turn in flight — defer to turn end.
    if (this.isTurnRunning) {
      this.restartPending = true;
      if (rest?.mode || rest?.effort || rest?.model || resume) {
        // KV too, not just the snapshot file — an agent death between turns must not
        // lose the pick to the last turn-end write.
        this._saveKvState();
        this.flushSaveSnapshot();
      }
      return;
    }
    // Forward only the validated id, and replay the restart's fetch — or a mode change holds every line forever.
    const fetch = this.adapter?.setOptions?.({ ...opts, resume });
    if (fetch?.then) fetch.then((f) => this._replay(f));
    // effort/mode/model are snapshot state: a reload or /clear rebuild must restore them.
    if (rest?.mode || rest?.effort || rest?.model || resume) {
      this._saveKvState();
      this.flushSaveSnapshot();
    }
  }

  // A change deferred while a turn was running, applied the moment it ends.
  applyPendingOptions() {
    if (!this.restartPending) return;
    this.restartPending = false;
    const fetch = this.adapter?.setOptions?.({ mode: this.permissionMode, model: this.model, effort: this.effort });
    if (fetch?.then) fetch.then((f) => this._replay(f));
  }

  // Resolved from a static spec so answering never spawns a session.
  async runDoctor() {
    return runEngineDoctor(this.engine, this.cwd, this.options.mock);
  }

  stop() {
    // A control request keeps the CLI alive; a signal is only the fallback when it cannot be written.
    const sent = this.adapter?.interrupt?.();
    const signalled = sent ? false : this.adapter?.signal?.("SIGINT");
    // Claiming an unmade stop desyncs the pane from the still-running CLI — report it instead.
    if (!sent && !signalled) {
      this.emitNormalized("error", { message: `${this.engine} could not stop this turn — the CLI is still running.` });
      return false;
    }
    this.emitNormalized("stopped", {});
    return true;
  }

  // Nothing emitted on purpose — the CLI's own task_notification settles the row on both paths.
  stopTask(taskId) {
    return this.adapter?.stopTask?.(taskId) || false;
  }

  // Reboot the adapter without touching the terminal PTY; handlers detach so the dying process cannot race the new one.
  async restart() {
    this.clearAllAsyncWatchdogs();
    this.isTurnRunning = false;
    this.turnStartedAt = 0;
    this.lastTurnMs = 0;
    this.skipOpenGates();

    const oldAdapter = this.adapter;
    this.adapter = null;
    if (oldAdapter) {
      try {
        await Promise.resolve(oldAdapter.stop?.());
      } catch {}
    }

    if (this.managed) {
      this.proc = new DaemonProc({ procId: this.id });
    }
    this.ready = this.initAdapter();
    await this.ready;

    this.refreshFromStore();
    this.emitNormalized("stopped", {});
    this._saveKvState(false);
    this.flushSaveSnapshot();
    return true;
  }

  destroy() {
    this.clearAllAsyncWatchdogs();
    if (this._drainTimer) { clearTimeout(this._drainTimer); this._drainTimer = null; }
    this.promptQueue = [];
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    // Wait for the async stop before unlinking, or its exit event writes the snapshot right back.
    const stopped = this.options.mock ? Promise.resolve() : this.adapter?.stop();
    // destroyed before emit, so nothing schedules a write after the unlink.
    this.destroyed = true;
    this.emitNormalized("stopped", {});
    const file = aiSnapshotFile(this.id, this.engine);
    const drop = () => { try { fs.unlinkSync(file); } catch {} };
    if (stopped?.then) stopped.then(drop, drop);
    else drop();
  }
}
