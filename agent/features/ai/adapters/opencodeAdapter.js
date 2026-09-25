// Adapter for OpenCode server (opencode serve) over HTTP/SSE.
import { AgentProc } from "../proc/agentProc.js";
import { createLogger } from "../../../lib/logger.js";
import { stageAttachment, stagedPaths } from "../aiAttachment.js";
import * as opencodeServer from "../opencodeServer.js";
import { createOpencodeBusParser, questionCardInput } from "../opencodeBus.js";
import { opencodePartEvents } from "../opencodePart.js";
import { OPENCODE_MODE_AGENTS, OPENCODE_TITLE_FETCH_DELAY_MS, OPENCODE_POLL_MS } from "../constants.js";

// The v2 prompt endpoint rejects an empty message; an attachment-only turn has no caption.
const ATTACHMENT_ONLY_PROMPT = "See the attached file.";

// Images must be passed as data: URLs; other files stay paths in the text.
function buildPromptBody(promptText, staged) {
  const images = (staged || []).filter((a) => a.kind === "image");
  const text = [stagedPaths(staged), promptText].filter(Boolean).join(" ")
    || (images.length ? ATTACHMENT_ONLY_PROMPT : "");
  return {
    parts: [
      { type: "text", text },
      ...images.map((a) => ({ type: "file", mime: a.mediaType, url: `data:${a.mediaType};base64,${a.data}` }))
    ]
  };
}

const logger = createLogger("ai");

export class OpenCodeAdapter {
  constructor({ cwd, onEvent, proc = null, sessionId = null, model = "", hostSessionId = null, server = null } = {}) {
    this.server = server || opencodeServer;
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    // Kept for adopt() compatibility; OpenCode server runs outside daemon.
    this.proc = proc || new AgentProc({ procId: "" });
    this.hostSessionId = hostSessionId;
    this.activeSessionId = sessionId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.currentVariant = "medium";
    this.permissionMode = "default";
    this.flags = [];
    this.stats = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTurns: 0 };
    // Empty model means CLI default; sent to server as real model id.
    this.metadata = { model: this.currentModel, sessionId: this.activeSessionId || "", permissionMode: this.permissionMode, variant: this.currentVariant };
    this.bus = null;         // {close} — the SSE subscription
    this.parser = null;      // bus envelopes → the pane's events
    this._interrupted = false;
    // True once a turn of this session observably ran (our prompt POST landed
    // or a turn end was seen) — force-applying switches before a first-ever
    // turn can kill it upstream, so a resumed session stays false until then.
    this._sessionRan = false;
    // Rebuilt adapter: upstream busyness is unknown until adopt() checks — an
    // idle-local flag must not green-light a PATCH into a live turn.
    this._adoptPending = Boolean(sessionId);
    // sendPrompt claims the turn synchronously but the POST leaves later; a
    // reconcile in that gap must not settle a turn that was never admitted.
    this._promptInFlight = false;
    // Open gates by request id — the session snapshot and resolvers read it.
    this.pendingRequests = new Map();
    // Model/mode picked mid-run wait here for the idle window (see _queueSwitches).
    this._pendingModel = false;
    this._pendingMode = false;
    this._switchRunning = false;
    this._switchQueued = false;
    this._switchForce = false;
    this._switchRun = Promise.resolve();
    // The CLI's own /command menu, fetched once and replayed on init.
    this._commands = [];
    this._commandsLoaded = false;
    this._commandsPromise = null;
    // Engine session id whose title the metadata already carries (see sendPrompt).
    this._titledSession = null;
    this._titleTimer = null;
    this._pollTimer = null;
  }

  setOptions({ model, variant, mode, resume, flags }) {
    let modelChanged = false;
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
      modelChanged = true;
    }
    if (variant) {
      this.currentVariant = variant;
      this.metadata.variant = variant;
      modelChanged = true;
    }
    if (mode) {
      this.permissionMode = mode;
      this.metadata.permissionMode = mode;
    }
    // Resume first: a pick landing in the same setOptions must see the
    // session id to be marked pending at all.
    if (resume && resume !== this.activeSessionId) {
      this.activeSessionId = resume;
      this._adoptPending = true;
      this.metadata.sessionId = resume;
      // The old conversation's title must not replay onto the new one.
      this.metadata.threadName = "";
    }
    if (this.activeSessionId) {
      // Only what changed — a needless PATCH still drops a synthetic
      // agent/model-switched row into the transcript. No session yet: the
      // choices ride the create call instead (see sendPrompt).
      if (modelChanged) this._pendingModel = true;
      if (mode) this._pendingMode = true;
      if (modelChanged || mode) this._queueSwitches();
    }
    if (flags && typeof flags === "object") {
      this.metadata.pure = Boolean(flags.pure);
      this.metadata.printLogs = Boolean(flags.printLogs);
    }
    this._refreshCommands();
    this.onEvent?.("init", { ...this.metadata });
  }

  // Adopt the server's own session title so the pane matches the TUI and /resume.
  _refreshServerTitle() {
    this._titleTimer = null;
    if (!this.activeSessionId || this._titledSession !== this.activeSessionId) return;
    this.server.getSession(this.activeSessionId)
      .then((info) => {
        const title = String(info?.title || "").trim();
        if (!title || title.startsWith("New session") || title === this.metadata.threadName) return;
        this.metadata.threadName = title.slice(0, 80);
        this.onEvent?.("init", { ...this.metadata });
      })
      .catch(() => {});
  }

  // Live command list (GET /command) feeds the web '/' menu through init.
  _refreshCommands() {
    if (this._commandsLoaded || this._commandsPromise) return;
    this._commandsPromise = this.server.listCommands()
      .then((list) => {
        this._commandsPromise = null;
        if (!Array.isArray(list) || !list.length) return;
        this._commandsLoaded = true;
        this._commands = list
          .map((c) => ({ name: String(c.name || ""), description: String(c.description || "") }))
          .filter((c) => c.name);
        this.metadata.commands = this._commands;
        this.onEvent?.("init", { ...this.metadata });
      })
      .catch(() => { this._commandsPromise = null; });
  }

  // A non-fatal adapter problem: a warning row, never an `error` event —
  // those release the running turn (aiStatus TURN_END_EVENTS).
  _warn(message) {
    this.onEvent?.("cli_event", { type: "warning", record: { message } });
  }

  _commandNames() {
    return new Set(this._commands.map((c) => c.name));
  }

  // Mode = agent on the engine (build/plan); applied when a session exists.
  _applyMode() {
    if (!this.activeSessionId) return Promise.resolve();
    const agent = OPENCODE_MODE_AGENTS[this.permissionMode];
    if (!agent) return Promise.resolve();
    // A re-applied mode must not PATCH: the server appends an "Agent: <name>" row
    // to the transcript for every switch, even a no-op one (measured on resume).
    // getSession runs inside the chain so a server without it fails open to PATCH.
    return Promise.resolve()
      .then(() => this.server.getSession(this.activeSessionId))
      .then((info) => {
        if (info?.agent === agent) return;
        return this.server.setSessionAgent(this.activeSessionId, agent);
      })
      .catch((e) => this._warn(`Could not switch the OpenCode mode: ${e.message}`));
  }

  // A gap in the bus (SSE reconnect) or a lost step.ended must not spin the
  // turn until a user stop: settle it when the engine itself says idle.
  _reconcileTurn() {
    if (!this.isTurnRunning || !this.activeSessionId) return;
    // A prompt we have not POSTed yet reads as idle upstream; settling it now
    // would emit a phantom turn_complete and defeat the double-prompt guard.
    if (this._promptInFlight) return;
    this.server.activeSessions()
      .then((active) => {
        const state = active?.[this.activeSessionId];
        if (this.isTurnRunning && (!state || state.type === "idle")) {
          this.isTurnRunning = false;
          this._queueSwitches();
          this.onEvent?.("turn_complete", { stats: this.stats, result: "", isError: false, subtype: "" });
        }
      })
      .catch(() => {});
  }

  // Card buttons → the engine's three-way reply (once/always/reject).
  resolvePermission(requestId, behavior, message = "") {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    this.pendingRequests.delete(requestId);
    // A question id is not a permission id — the permission route would miss the gate's
    // store and the question stays open. Skip on a question is a reject on that store.
    if (pending.toolName === "AskUserQuestion") {
      this.server.rejectQuestion(requestId, this.cwd)
        .catch((e) => this._warn(`OpenCode question reply failed: ${e.message}`));
      return true;
    }
    const reply = behavior === "allow" ? "once" : behavior === "allowAlways" ? "always" : "reject";
    this.server.replyPermission(this.activeSessionId, requestId, reply, message)
      .catch((e) => this._warn(`OpenCode permission reply failed: ${e.message}`));
    return true;
  }

  // Card answers are keyed by question text; the engine wants label arrays in order.
  resolveQuestion(requestId, answers = {}) {
    if (!this.pendingRequests.has(requestId)) return false;
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    const perQuestion = (pending.input?.questions || []).map((q) =>
      [].concat(answers?.[q.question] ?? []).map(String).filter(Boolean));
    const call = perQuestion.some((a) => a.length)
      ? this.server.replyQuestion(requestId, perQuestion, this.cwd)
      : this.server.rejectQuestion(requestId, this.cwd);
    call.catch((e) => this._warn(`OpenCode question reply failed: ${e.message}`));
    return true;
  }

  // "provider/id" → the server's Model.Ref; null when the model is not prefixed.
  _modelRef() {
    const parts = (this.currentModel || "").split("/");
    return parts.length >= 2 ? { id: parts.slice(1).join("/"), providerID: parts[0] } : null;
  }

  // ONE door for model/agent switching: PATCHes serialize, coalesce to the
  // latest choice, and only ever land in an idle window between turns — a
  // switch while the runner is admitted/running can kill its continuation
  // upstream with no end-of-turn event (measured on 1.18.32). `force` is the
  // pre-prompt window: the session is idle even though sendPrompt already
  // claimed isTurnRunning for the upcoming turn.
  _queueSwitches(force = false) {
    if (this._switchRunning) {
      // A forced pass piggybacked onto a running one must survive: the run's
      // next iteration would otherwise inherit `now = false` and skip.
      this._switchQueued = true;
      this._switchForce = this._switchForce || force;
      return this._switchRun;
    }
    this._switchRunning = true;
    this._switchQueued = true;
    this._switchForce = force;
    this._switchRun = Promise.resolve().then(async () => {
      try {
        while (this._switchQueued) {
          this._switchQueued = false;
          const now = this._switchForce;
          this._switchForce = false;
          if ((!now && this.isTurnRunning) || !this.activeSessionId) continue;
          // Rebuilt adapter, busyness unknown: verify upstream idle once
          // before the first PATCH, or a live turn dies with the pane watching.
          if (this._adoptPending) {
            const busy = await this.server.activeSessions()
              .then((active) => {
                const state = active?.[this.activeSessionId];
                return Boolean(state && state.type !== "idle");
              })
              .catch(() => false);
            if (busy) continue; // dirty flags intact; the turn-end wake re-pokes
            this._adoptPending = false;
          }
          const model = this._pendingModel, mode = this._pendingMode;
          this._pendingModel = this._pendingMode = false;
          if (model) await this._applyModel();
          if (mode) await this._applyMode();
        }
      } finally {
        this._switchRunning = false;
      }
    });
    return this._switchRun;
  }

  // Set session model on server; model requires provider prefix. No variant —
  // the catalog models here expose none and an unknown variant fails the next
  // step resolve with no end-of-turn event (silent hang).
  async _applyModel() {
    const ref = this._modelRef();
    if (!this.activeSessionId || !ref) return;
    try {
      await this.server.setSessionModel(this.activeSessionId, ref);
    } catch (e) {
      this._warn(`Could not set the OpenCode model: ${e.message}`);
    }
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "opencode", args: ["debug", "info"] };
  }

  // Re-attach to running session on server after agent restart.
  async adopt(from = 0, epoch = null) {
    const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
    const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
    const fetch = await this.proc.attach(f, ep);
    if (this.activeSessionId) {
      this._ensureBus();
      try {
        const active = await this.server.activeSessions();
        const state = active?.[this.activeSessionId];
        // Upstream busyness is now known — switches no longer need the guard.
        this._adoptPending = false;
        if (state && state.type !== "idle") this.isTurnRunning = true;
      } catch {
      }
    }
    return fetch;
  }

  feed() {}

  _ensureParser() {
    if (!this.parser) {
      this.parser = createOpencodeBusParser({
        onEvent: (event, data) => this._onBusEvent(event, data),
        stats: this.stats
      });
    }
  }

  _ensureBus() {
    if (this.bus) return;
    this._ensureParser();
    this.bus = this.server.subscribeBus((envelope) => {
      const data = envelope?.data;
      if (!data || data.sessionID !== this.activeSessionId) return;
      if (envelope.type === "session.next.step.started" && data.model?.id) {
        const full = data.model.providerID ? `${data.model.providerID}/${data.model.id}` : data.model.id;
        // A pick still waiting for its idle window outranks the in-flight
        // turn's own model — the engine's report describes the CURRENT turn,
        // not the next one the user already chose.
        if (full !== this.metadata.model && !this._pendingModel) {
          this.metadata.model = full;
          this.currentModel = full;
          this.onEvent?.("init", { ...this.metadata });
        }
      }
      this.parser.handle(envelope);
    }, { onReconnect: () => this._reconcileTurn() });
  }

  handleEvent(envelope) {
    this._ensureParser();
    this.parser.handle(envelope);
  }

  _onBusEvent(event, data) {
    // Gate mirror: pendingRequests feeds the session snapshot and resolvers.
    if (event === "permission_request") {
      // Mode auto mirrors the TUI's --dangerously-skip-permissions: the client
      // itself replies "once" to every ask (the CLI's run.ts does the same), so
      // no card interrupts the turn. AskUserQuestion is the MODEL asking the
      // user, not a permission gate — it always reaches the card. A failed
      // auto-reply falls back to the card too.
      if (this.permissionMode === "auto" && this.activeSessionId && data.tool !== "AskUserQuestion") {
        this.server.replyPermission(this.activeSessionId, data.requestId, "once")
          .catch(() => {
            this.isTurnRunning = true;
            this.pendingRequests.set(data.requestId, { toolName: data.tool, input: data.input });
            this.onEvent?.("permission_request", data);
          });
        return;
      }
      this.isTurnRunning = true;
      this.pendingRequests.set(data.requestId, { toolName: data.tool, input: data.input });
    } else if (event === "permission_resolved") {
      this.pendingRequests.delete(data.requestId);
    }
    // Swallow error echo from an interrupt we initiated.
    if (event === "error" && this._interrupted) {
      this._interrupted = false;
      this.isTurnRunning = false;
      return;
    }
    if (event === "turn_complete" || event === "error") {
      this.isTurnRunning = false;
      this._queueSwitches();
    }
    this.onEvent?.(event, data);
  }

  // The server's own rename; the pane's title watcher adopts it on the next poll.
  async renameThread(name) {
    if (!this.activeSessionId) return false;
    await this.server.renameSession(this.activeSessionId, name);
    this.metadata.threadName = name.slice(0, 80);
    this.onEvent?.("init", { ...this.metadata });
    return true;
  }

  sendPrompt(promptText, attachments = null) {
    if (this.isTurnRunning) {
      throw new Error("OpenCode turn is already running.");
    }
    this.isTurnRunning = true;
    this._interrupted = false;
    this._promptInFlight = true;
    const staged = attachments?.length ? attachments.map(stageAttachment) : null;
    Promise.resolve().then(async () => {
      try {
        if (!this.activeSessionId) {
          // Born with the choices: any model/agent PATCH around the first turn's
          // admission can kill the run upstream (see _queueSwitches) —
          // creation-time fields are the only safe carrier for a fresh session.
          const bornModel = this._modelRef();
          const bornAgent = OPENCODE_MODE_AGENTS[this.permissionMode];
          const session = await this.server.createSession(this.cwd, {
            ...(bornModel ? { model: bornModel } : {}),
            ...(bornAgent ? { agent: bornAgent } : {})
          });
          if (this._interrupted) return;
          if (!session?.id) throw new Error("The opencode server created no session.");
          this.activeSessionId = session.id;
          this._adoptPending = false;
          this.metadata.sessionId = session.id;
          // A pick that raced into the create RTT changed currentModel after
          // the birth body left: catch it now or the UI/engine desync forever.
          if (this._modelRef()?.id !== bornModel?.id) this._pendingModel = true;
          if (OPENCODE_MODE_AGENTS[this.permissionMode] !== bornAgent) this._pendingMode = true;
          this.onEvent?.("init", { ...this.metadata });
        }
        if (this._interrupted) return;
        if (this._sessionRan) {
          // Idle window before our own prompt: settle any deferred switch fully
          // so no PATCH can land inside the admission window upstream.
          await this._queueSwitches(true);
          if (this._interrupted) return;
        }
        this._ensureBus();
        // Cold-start: a command sent before the list answers must wait for it,
        // not fall through to the LLM as plain text.
        if (this._commandsPromise) await this._commandsPromise.catch(() => {});
        // Whole-text known command → the CLI's own command route, not a prompt.
        if (!staged) {
          const slash = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/.exec((promptText || "").trim());
          if (slash && this._commandNames().has(slash[1])) {
            await this._followTurn(this.activeSessionId, this.server.runCommand(this.activeSessionId, {
              command: slash[1],
              arguments: slash[2] || "",
              // No variant: same no-variants catalog rule as the model PATCH.
              ...(this.currentModel ? { model: this.currentModel } : {})
            }));
            // A command runs the whole agent loop — it proves the session ran.
            this._sessionRan = true;
            // The command call blocks until the loop ends; its return is itself
            // the authoritative turn end when the bus missed the events. Clear
            // the in-flight flag first — reconcile refuses to settle otherwise.
            this._promptInFlight = false;
            this._reconcileTurn();
            return;
          }
        }
        await this._followTurn(this.activeSessionId, this.server.prompt(this.activeSessionId, buildPromptBody(promptText, staged)));
        this._sessionRan = true;
        // The pane header needs a title instantly; the server's own (from the
        // title model, like the TUI) lands a beat later and replaces this.
        if (this._titledSession !== this.activeSessionId) {
          this._titledSession = this.activeSessionId;
          const firstLine = String(promptText || "").split("\n")[0].trim();
          if (firstLine) {
            this.metadata.threadName = firstLine.slice(0, 80);
            this.onEvent?.("init", { ...this.metadata });
          }
          // The message route makes the server title the session like the TUI
          // does; swap the first-line stand-in for it once it lands.
          this._titleTimer = setTimeout(() => this._refreshServerTitle(), OPENCODE_TITLE_FETCH_DELAY_MS);
        }
      } finally {
        this._promptInFlight = false;
      }
    }).catch((e) => {
      this.isTurnRunning = false;
      if (!this._interrupted) {
        this.onEvent?.("error", { message: e.message });
      }
    });
  }

  // The v1 routes persist every part but relay none of the assistant's content
  // on the event bus (only the user's message is published), so the pane follows
  // the turn by polling the store those routes write. `done` is the route call
  // itself, already in flight; it resolves when the whole agent loop ends, which
  // is the authoritative turn end.
  async _followTurn(sessionId, done) {
    const sentText = new Map();   // part id → chars already emitted
    const toolState = new Map();  // part id → last emitted state.status
    const counted = new Set();    // message ids whose tokens already hit stats
    // markOnly: record what the store holds without emitting — the baseline
    // pass must mark the past as seen, never replay it into the live turn.
    const consume = (messages, markOnly = false) => {
      let last = null;
      for (const m of messages || []) {
        if (m?.info?.role !== "assistant") continue;
        last = m;
        const id = m.info.id;
        if (!counted.has(id) && m.info.time?.completed) {
          counted.add(id);
          if (!markOnly) {
            const t = m.info.tokens || {};
            // Same rule as the bus parser: the last step's input is what the window
            // holds; output/reasoning bill per message.
            this.stats.inputTokens = t.input || 0;
            this.stats.outputTokens = (this.stats.outputTokens || 0) + (t.output || 0);
            this.stats.reasoningTokens = (this.stats.reasoningTokens || 0) + (t.reasoning || 0);
            this.stats.contextTokens = t.input || 0;
          }
        }
        for (const part of m.parts || []) {
          if (part.type === "text" || part.type === "reasoning") {
            const text = String(part.text || "");
            const at = sentText.get(part.id) || 0;
            if (text.length > at) {
              // A part can land whole or keep growing in the store — the suffix
              // is the delta either way.
              sentText.set(part.id, text.length);
              if (!markOnly) this.onEvent?.(part.type === "text" ? "delta" : "thinking", { text: text.slice(at) });
            }
          } else if (part.type === "tool") {
            const status = part.state?.status || "";
            if (toolState.get(part.id) === status) continue;
            toolState.set(part.id, status);
            // tool_start repeats are upserts, so re-announcing on completion is
            // how the card gets its result.
            if (!markOnly) for (const ev of opencodePartEvents(part)) this.onEvent?.(ev.event, ev.data);
          }
        }
      }
      return last;
    };
    // Baseline: everything already in the store is the past, not this turn.
    try { consume(await this.server.listMessages(sessionId), true); } catch {}
    // The question tool blocks on a gate the v1 routes never announce on the bus:
    // the pending /question list is the only live signal, and its que_ ids are
    // what the reply route takes. The list is instance state scoped by directory,
    // so the poll must carry the session's cwd — the serve process's is another store.
    const carded = new Set();
    const askCards = async () => {
      let pending;
      try { pending = await this.server.listPendingQuestions(this.cwd); } catch { return; }
      const mine = (pending || []).filter((q) => q.sessionID === sessionId);
      for (const q of mine) {
        if (carded.has(q.id)) continue;
        carded.add(q.id);
        const input = questionCardInput(q.questions);
        this.pendingRequests.set(q.id, { toolName: "AskUserQuestion", input });
        this.onEvent?.("permission_request", { requestId: q.id, tool: "AskUserQuestion", input, type: "permission" });
      }
      // A question that left the list without passing through resolveQuestion
      // was answered elsewhere or rejected — drop its card.
      for (const id of carded) {
        if (mine.some((q) => q.id === id) || !this.pendingRequests.has(id)) continue;
        this.pendingRequests.delete(id);
        this.onEvent?.("permission_resolved", { requestId: id });
      }
    };
    const poll = () => Promise.all([
      this.server.listMessages(sessionId).then(consume).catch(() => {}),
      askCards()
    ]);
    this._pollTimer = setInterval(poll, OPENCODE_POLL_MS);
    try {
      await done;
    } finally {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    await poll();
    this.isTurnRunning = false;
    this._queueSwitches();
    this.stats.totalTurns = (this.stats.totalTurns || 0) + 1;
    this.onEvent?.("stats", { stats: this.stats });
    this.onEvent?.("turn_complete", { stats: this.stats, result: "", isError: false, subtype: "" });
  }

  // Interrupt current turn on server; session and context are preserved.
  interrupt() {
    if (!this.isTurnRunning) return false;
    this._interrupted = true;
    this.isTurnRunning = false;
    if (this.activeSessionId) {
      this.server.interruptSession(this.activeSessionId).catch(() => {});
    }
    return true;
  }

  signal(sig) {
    return this.interrupt();
  }

  stop() {
    this.isTurnRunning = false;
    if (this._titleTimer) { clearTimeout(this._titleTimer); this._titleTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this.bus?.close();
    this.bus = null;
    this.parser = null;
    if (this.activeSessionId) this.server.interruptSession(this.activeSessionId).catch(() => {});
    return Promise.resolve();
  }
}
