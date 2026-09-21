// Adapter for OpenCode server (opencode serve) over HTTP/SSE.
import { AgentProc } from "../proc/agentProc.js";
import { createLogger } from "../../../lib/logger.js";
import { stageAttachment, stagedPaths } from "../aiAttachment.js";
import * as opencodeServer from "../opencodeServer.js";
import { createOpencodeBusParser } from "../opencodeBus.js";
import { OPENCODE_MODE_AGENTS } from "../constants.js";

// The v2 prompt endpoint rejects an empty message; an attachment-only turn has no caption.
const ATTACHMENT_ONLY_PROMPT = "See the attached file.";

// Images must be passed as data: URLs; other files stay paths in the text.
function buildPromptBody(promptText, staged) {
  const images = (staged || []).filter((a) => a.kind === "image");
  const text = [stagedPaths(staged), promptText].filter(Boolean).join(" ")
    || (images.length ? ATTACHMENT_ONLY_PROMPT : "");
  return {
    prompt: {
      text,
      ...(images.length
        ? { files: images.map((a) => ({ uri: `data:${a.mediaType};base64,${a.data}` })) }
        : {})
    }
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
    return this.server.setSessionAgent(this.activeSessionId, agent)
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
    if (!this.pendingRequests.has(requestId)) return false;
    this.pendingRequests.delete(requestId);
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
      ? this.server.replyQuestion(this.activeSessionId, requestId, perQuestion)
      : this.server.rejectQuestion(this.activeSessionId, requestId);
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
            await this.server.runCommand(this.activeSessionId, {
              command: slash[1],
              arguments: slash[2] || "",
              // No variant: same no-variants catalog rule as the model PATCH.
              ...(this.currentModel ? { model: this.currentModel } : {})
            });
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
        await this.server.prompt(this.activeSessionId, buildPromptBody(promptText, staged));
        this._sessionRan = true;
        // serve mode never auto-titles a session (only the TUI does), so the
        // pane would otherwise show the placeholder "New session - <ts>" from
        // the store. The first prompt is the title, claude-style, once per
        // engine session.
        if (this._titledSession !== this.activeSessionId) {
          this._titledSession = this.activeSessionId;
          const firstLine = String(promptText || "").split("\n")[0].trim();
          if (firstLine) {
            this.metadata.threadName = firstLine.slice(0, 80);
            this.onEvent?.("init", { ...this.metadata });
          }
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
    this.bus?.close();
    this.bus = null;
    this.parser = null;
    if (this.activeSessionId) this.server.interruptSession(this.activeSessionId).catch(() => {});
    return Promise.resolve();
  }
}
