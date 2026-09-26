// Adapter for the Hermes CLI (`hermes acp`): one long-lived ACP JSON-RPC process
// per chat, daemon-owned so it survives agent restarts. A saved conversation
// reopens on a fresh process via session/load — hermes restores it from its own
// state.db, so resume crosses process deaths. Wire shapes measured from
// hermes-agent 0.21.4 (.source/hermes 42c1a93) with graceful fallbacks to the
// installed 0.10.0 (no set_model/set_mode, no plan/usage/commands updates).
import { DaemonProc, decodeLine } from "../proc/daemonProc.js";
import { JsonRpcClient } from "../proc/jsonRpcClient.js";
import { stageAttachment, buildAttachedPrompt } from "../aiAttachment.js";
import { buildEditPatch } from "./claudeAdapter.js";
import { getExtendedEnv } from "./env.js";
import { HERMES_EFFORTS, setHermesReasoningEffort, resolveDefaultEffort, setHermesLiveCatalog } from "../models.js";
import { readHermesSessionTitle, renameHermesSession } from "../../terminal/agentHistory.js";
import { createLogger } from "../../../lib/logger.js";

const logger = createLogger("ai");

const HANDSHAKE_TIMEOUT_MS = 60000;
const PROMPT_TIMEOUT_MS = 600000;
// Hermes titles the session a beat after the turn ends — like opencode's title fetch.
const TITLE_FETCH_DELAY_MS = 5000;

// Text out of an ACP content list: items nest the payload under `content`.
const contentText = (content) => (Array.isArray(content) ? content : [])
  .map((c) => c?.content?.text ?? c?.text ?? "")
  .filter(Boolean)
  .join("\n");

// Hermes titles its tool calls ("terminal: npm test", "read: src/app.js") and the
// wire carries no tool NAME — only these title prefixes and the raw tool name for
// everything else (build_tool_title in acp_adapter/tools.py).
const TITLE_TOOLS = [
  [/^terminal: /, "terminal"], [/^read: /, "read_file"], [/^write: /, "write_file"],
  [/^patch \(/, "patch"], [/^search: /, "search_files"], [/^web search: /, "web_search"],
  [/^extract: /, "web_extract"], [/^delegate: /, "delegate_task"], [/^execute code/, "execute_code"],
  [/^analyze image: /, "vision_analyze"]
];
const toolNameOf = (title) => {
  for (const [re, name] of TITLE_TOOLS) if (re.test(title || "")) return name;
  return String(title || "tool");
};

// One diff content block → the pane's diff event shape.
function diffEvent(content, name) {
  const d = (Array.isArray(content) ? content : []).find((c) => c?.type === "diff" && c.path);
  if (!d) return null;
  return { file: d.path, name, patch: buildEditPatch(name, { old_string: d.oldText, new_string: d.newText }), content: "" };
}

export class HermesAdapter {
  constructor({ cwd, onEvent, proc = null, sessionId = null, model = "", hostSessionId = null } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.hostSessionId = hostSessionId;
    this.proc = proc || new DaemonProc({ procId: "" });
    this.activeSessionId = sessionId || null;
    // The conversation the NEXT spawn must session/load — the id survives process recycles.
    this._resumeId = sessionId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.pendingRequests = new Map(); // requestId → {options}
    this.toolCalls = new Map(); // toolCallId → {name, kind, input}
    this._toolSeq = 0;
    this._planSeq = 0;
    this.stats = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTurns: 0, contextTokens: 0, contextWindow: 0 };
    this.metadata = { model: this.currentModel, sessionId: this.activeSessionId || "", permissionMode: "default", effort: "", threadName: "", commands: [] };
    // The mode the pane wants — rides the spawn as --yolo (dont_ask) and set_mode.
    this.desiredMode = null;
    this._spawnedYolo = null;
    this.currentEffort = "";
    this._pendingEffortApply = null;
    this._titledSession = null;
    this._titleTimer = null;
    this._catalogEmitted = false;
    // A recycle in flight (resume switch): the next spawn waits for it.
    this._stopping = null;
  }

  // Non-fatal adapter problem: a warning row, never an `error` event (those
  // release the running turn).
  _warn(message) {
    this.onEvent?.("cli_event", { type: "warning", record: { message } });
  }

  // "provider:model" picker ids → the pane's model options.
  static _modelOptions(models) {
    const list = (Array.isArray(models?.availableModels) ? models.availableModels : [])
      .map((m) => {
        const id = String(m?.modelId || "").trim();
        if (!id) return null;
        const provider = id.includes(":") ? id.slice(0, id.indexOf(":")) : "";
        return { id, label: String(m?.name || id), short: String(m?.name || id), ...(provider ? { provider } : {}) };
      })
      .filter(Boolean);
    return list;
  }

  // --yolo is a global flag (before the subcommand) and HERMES_YOLO_MODE freezes at
  // import — the full-permission level it grants cannot change on a live process.
  _spawnArgs() {
    return [...(this.desiredMode === "dont_ask" ? ["--yolo"] : []), "acp", "--accept-hooks"];
  }

  async _ensureStarted() {
    if (this.rpc) return;
    // A recycle may still be tearing the old process down; start only once free.
    if (this._stopping) { await this._stopping; this._stopping = null; }
    this._spawnedYolo = this.desiredMode === "dont_ask";
    const started = await this.proc.start({
      bin: "hermes",
      // Auto-approve 9remote's own shell hooks — the pane gates real work itself.
      args: this._spawnArgs(),
      cwd: this.cwd,
      env: getExtendedEnv({ hostSessionId: this.hostSessionId }),
      keepStdin: true
    });
    // Standard JSON-RPC envelope — the stock codecs speak ACP as-is; ids can be
    // ints (permission requests), which the default extractors accept.
    this.rpc = new JsonRpcClient(this.proc, { onMessage: (m) => this.handleFrame(m) });
    this.rpc.on("session/request_permission", (params, id) => this._onPermission(params, id));
    this.rpc.onExit((info) => this._handleExit(info));
    // DaemonProc holds the spawn's lines until committed — skip it and the
    // initialize answer starves (audited; same trap as devin/omp).
    started.commit?.((line) => this.rpc.feed(line));
    await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    }, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
    const params = { cwd: this.cwd, mcpServers: [] };
    let session = null;
    if (this._resumeId) {
      // A resume id the CLI no longer holds must not wedge the pane: fall
      // through to a fresh conversation and say so.
      try {
        session = await this.rpc.request("session/load", { ...params, sessionId: this._resumeId }, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
      } catch {
        this._resumeId = null;
        // Older hermes (0.10.x) only loads sessions its own process created — a
        // past conversation exists but cannot reenter the pane until `hermes update`.
        this._warn("Hermes could not reopen that conversation (older versions cannot load past sessions into the pane — `hermes update` helps). Starting a new one.");
      }
    }
    session ||= await this.rpc.request("session/new", params, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
    this._absorbSession(session);
    // A mode picked before the process existed: hermes opened the session with its
    // own config default — push the pane's pick now that the wire is up.
    if (this.desiredMode && this.desiredMode !== this.metadata.permissionMode) {
      this.rpc.request("session/set_mode", { sessionId: this.activeSessionId, modeId: this.desiredMode }, { timeoutMs: HANDSHAKE_TIMEOUT_MS })
        .then(() => {
          this.metadata.permissionMode = this.desiredMode;
          this._emitInit();
        })
        .catch(() => {});
    }
    this._scheduleTitleRefresh();
    this._emitInit();
  }

  // session/new|load answer: the ids the pane needs plus the model catalog and
  // the current mode the wire volunteered.
  _absorbSession(session) {
    this.activeSessionId = this._resumeId = session.sessionId || this._resumeId;
    this.metadata.sessionId = this.activeSessionId || "";
    const options = HermesAdapter._modelOptions(session.models);
    if (options.length) {
      this.metadata.modelOptions = options;
      // Every later connect ack serves the real catalog through models.js, so the
      // one-model config fallback never overwrites the menu on reconnect.
      setHermesLiveCatalog(options);
    }
    // The session's own report describes the CLI's config default — a model the
    // user already picked through the pane outranks it.
    if (!this.currentModel && session.models?.currentModelId) {
      this.currentModel = this.metadata.model = session.models.currentModelId;
    }
    if (session.modes?.currentModeId) this.metadata.permissionMode = session.modes.currentModeId;
  }

  _handleExit({ code, signal, error } = {}) {
    const wasRunning = this.isTurnRunning;
    this.rpc = null;
    this.isTurnRunning = false;
    // A dead process waits on nothing; stale entries keep the idle watchdog stood down.
    this.pendingRequests.clear();
    if (error) this.onEvent?.("error", { message: error });
    // child.on('close') carries only code/signal (no error field) — a CLI killed mid-turn
    // used to end silently because both the `error` check and isError missed it.
    else if (wasRunning) this.onEvent?.("turn_complete", { stats: this.stats, result: code != null && code !== 0 ? `Hermes exited (code ${code}).` : signal ? `Hermes was killed (${signal})` : "", isError: (code != null && code !== 0) || Boolean(signal), subtype: "exit" });
  }

  setOptions({ model, mode, effort, resume } = {}) {
    if (model && model !== this.currentModel) {
      this.currentModel = this.metadata.model = model;
      if (this.rpc) {
        // Wire-level switch first; the /model slash command is the door every
        // version shares (idle-only there).
        this.rpc.request("session/set_model", { sessionId: this.activeSessionId, modelId: model }, { timeoutMs: HANDSHAKE_TIMEOUT_MS })
          .catch(() => {
            if (this.isTurnRunning) {
              this._warn("Hermes applies a new model when the turn ends — pick it again then.");
              return;
            }
            this._slash(`/model ${model}`);
          });
      }
    }
    if (mode && mode !== this.metadata.permissionMode) {
      this.desiredMode = mode;
      if (!this.rpc) {
        this.metadata.permissionMode = mode;
      } else if (this._spawnedYolo !== null && (mode === "dont_ask") !== this._spawnedYolo) {
        // Crossing the dont_ask line is a spawn-level change (--yolo env is frozen
        // at import) — set_mode cannot grant or revoke it on a live process.
        this.metadata.permissionMode = mode;
        this._recycle();
        this._warn("Hermes permission level changed — its process restarts to apply.");
      } else {
        this.rpc.request("session/set_mode", { sessionId: this.activeSessionId, modeId: mode }, { timeoutMs: HANDSHAKE_TIMEOUT_MS })
          .then(() => {
            // Hermes answers but does not broadcast a mode update — the pane's
            // own pick is the state to show.
            this.metadata.permissionMode = mode;
            this._emitInit();
          })
          .catch(() => this._warn("This Hermes version holds its mode in config — the pane shows it but cannot switch."));
      }
    }
    if (typeof effort === "string" && HERMES_EFFORTS.has(effort)) {
      if (effort !== this.currentEffort) {
        this.currentEffort = effort;
        this.metadata.effort = effort;
      }
      // The wire has no reasoning switch: config.yaml is the only door and it is
      // read once per session build, so a change costs a config write + recycle.
      // A value already in the config (a rebuild re-sending the saved pick) skips it.
      if (effort !== resolveDefaultEffort("hermes")) {
        const apply = () => {
          try {
            setHermesReasoningEffort(effort);
            this._recycle();
            this._warn(`Hermes thinking level set to ${effort} — its process restarts to apply.`);
          } catch (e) {
            this._warn(`Could not set the Hermes thinking level: ${e.message}`);
          }
        };
        if (this.isTurnRunning) this._pendingEffortApply = apply;
        else apply();
      }
    }
    if (resume && resume !== this._resumeId) {
      this._resumeId = resume;
      this.activeSessionId = resume;
      this.metadata.sessionId = resume;
      // The live process holds the OLD conversation: recycle so the next
      // spawn session/loads the resumed one.
      if (this.rpc) this._recycle();
      this._warn("Hermes conversation switched — its process restarts to apply.");
    }
    this._emitInit();
  }

  // Tear the CLI down; the next prompt's _ensureStarted respawns (keeping the
  // conversation via session/load and the level via spawn args).
  _recycle() {
    this.rpc?.close();
    this.rpc = null;
    this._stopping = this.proc.stop().catch(() => {});
  }

  _emitInit() {
    // The 288-row catalog rides the FIRST init only — every later one (mode, title,
    // commands) would record another ~20KB copy into the replay log's 32KB window.
    // Reconnects get the catalog from the connect ack via setHermesLiveCatalog.
    const data = { ...this.metadata };
    if (this._catalogEmitted) delete data.modelOptions;
    else if (data.modelOptions?.length) this._catalogEmitted = true;
    this.onEvent?.("init", data);
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "hermes", args: ["doctor"] };
  }

  // Re-attach to the still-running process after an agent restart.
  async adopt(from = 0, epoch = null) {
    const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
    const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
    const fetch = await this.proc.attach(f, ep);
    if (!fetch.alive) return fetch;
    // The daemon-held process was spawned for the persisted mode — same flag state.
    this._spawnedYolo = this.desiredMode === "dont_ask";
    this.rpc = new JsonRpcClient(this.proc, { onMessage: (m) => this.handleFrame(m) });
    this.rpc.on("session/request_permission", (params, id) => this._onPermission(params, id));
    this.rpc.onExit((info) => this._handleExit(info));
    // The gap's lines are NOT committed here: _replay commits each buffer exactly
    // once, and its door is adapter.feed — one delivery per replayed frame.
    this.isTurnRunning = this._midTurn(fetch.lines);
    return fetch;
  }

  // Mid-turn iff the last meaningful frame is streaming output, not the prompt's
  // answer: the process idles between turns, so `alive` alone is not a turn.
  _midTurn(lines = []) {
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec;
      try { rec = JSON.parse(decodeLine(lines[i])); } catch { continue; }
      if (rec?.result?.stopReason != null) return false;
      if (rec?.method === "session/update") return true;
    }
    return false;
  }

  sendPrompt(promptText, attachments = null) {
    if (this.isTurnRunning) throw new Error("Hermes turn is already running.");
    const staged = attachments?.length ? attachments.map(stageAttachment) : null;
    // 0.10.0 drops image blocks in prompt extraction (measured) — files and
    // captions ride the text until the installed CLI carries them.
    const prompt = [{ type: "text", text: buildAttachedPrompt(promptText, staged) }];
    this.isTurnRunning = true;
    Promise.resolve()
      .then(() => this._ensureStarted())
      .then(() => this.rpc.request("session/prompt", { sessionId: this.activeSessionId, prompt }, { timeoutMs: PROMPT_TIMEOUT_MS }))
      .then((res) => this._finishTurn(res))
      .catch((e) => {
        this.isTurnRunning = false;
        this.onEvent?.("error", { message: e.message });
      });
  }

  // A '/' the CLI itself answers (model switch fallback) — a real turn on the wire.
  _slash(text) {
    Promise.resolve()
      .then(() => this._ensureStarted())
      .then(() => this.rpc.request("session/prompt", { sessionId: this.activeSessionId, prompt: [{ type: "text", text }] }, { timeoutMs: PROMPT_TIMEOUT_MS }))
      .then((res) => this._finishTurn(res))
      .catch((e) => this._warn(`Hermes /command failed: ${e.message}`));
  }

  // Replay-only door, independent of the rpc (a dead process has none).
  feed(line) {
    let msg = null;
    try { msg = JSON.parse(String(line)); } catch { return; }
    if (msg?.result?.stopReason != null) return this._finishTurn(msg.result);
    if (msg?.method === "session/request_permission" && msg.id != null) {
      return this._onPermission(msg.params || {}, msg.id);
    }
    this.handleFrame(msg);
  }

  interrupt() {
    if (!this.rpc) return false;
    this.isTurnRunning = false;
    // Idempotent server-side: send even if the turn already ended so a missed
    // stop never strands the pane.
    this.rpc.notify("session/cancel", { sessionId: this.activeSessionId });
    return true;
  }

  signal(sig = "SIGINT") {
    if (this.rpc) return this.interrupt();
    if (typeof this.proc?.signal !== "function") return false;
    try { this.proc.signal(sig); return true; } catch { return false; }
  }

  stop() {
    this.isTurnRunning = false;
    if (this._titleTimer) { clearTimeout(this._titleTimer); this._titleTimer = null; }
    this.rpc?.close();
    this.rpc = null;
    // The daemon-held process IS the conversation; a recycle already in flight
    // is awaited instead of double-stopping.
    const stopping = this._stopping || this.proc.stop().catch(() => {});
    this._stopping = stopping;
    return stopping;
  }

  // ── gates ──────────────────────────────────────────────────────────────────
  _onPermission(params, id) {
    const call = params?.toolCall || {};
    const raw = call.rawInput || {};
    const input = raw.arguments || (raw.command ? { command: raw.command } : {});
    const name = raw.tool || (raw.command ? "terminal" : toolNameOf(call.title));
    this.isTurnRunning = true;
    this.pendingRequests.set(id, { options: Array.isArray(params?.options) ? params.options : [] });
    this.onEvent?.("permission_request", {
      requestId: id,
      tool: name,
      input,
      type: "permission"
    });
  }

  // The card offers Allow / Allow-always / Deny; the wire's tiers are richer
  // (allow_session vs allow_always, deny_always) — the coarsest safe choice wins.
  resolvePermission(requestId, behavior) {
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    if (!pending) return false;
    const has = (oid) => pending.options.some((o) => o?.optionId === oid);
    let optionId;
    if (behavior === "allow") optionId = "allow_once";
    else if (behavior === "allowAlways") optionId = has("allow_always") ? "allow_always" : "allow_session";
    else optionId = has("deny") ? "deny" : "deny_always";
    this.rpc?.respond(requestId, { outcome: { outcome: "selected", optionId } });
    return true;
  }

  // No ask-style dialogs on this wire — the honest answer.
  resolveQuestion() {
    return false;
  }

  // ── frames ─────────────────────────────────────────────────────────────────
  handleFrame(m) {
    if (!m || typeof m !== "object") return;
    if (m.method === "session/update") return this._onUpdate(m.params?.update || {});
    // A replayed prompt answer (live ones settle inside the request call).
    if (m.result?.stopReason != null) return this._finishTurn(m.result);
  }

  _onUpdate(u) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.text || "";
        if (!text) return;
        this.isTurnRunning = true;
        this.onEvent?.("delta", { text });
        return;
      }
      case "agent_thought_chunk": {
        const text = u.content?.text || "";
        if (!text) return;
        this.isTurnRunning = true;
        this.onEvent?.("thinking", { text });
        return;
      }
      case "user_message_chunk":
        // The pane already drew the prompt it sent — a replayed echo is a double row.
        return;
      case "tool_call": {
        const id = u.toolCallId || `hermes-${this._toolSeq++}`;
        const raw = u.rawInput || {};
        const name = raw.tool || toolNameOf(u.title);
        this.toolCalls.set(id, { name, kind: u.kind || "", input: raw.arguments || raw });
        this.isTurnRunning = true;
        this.onEvent?.("tool_start", { id, name, input: raw.arguments || raw, status: "running", title: u.title });
        // A write lands with its whole diff up front — the card shows it before completion.
        if (u.kind === "edit") {
          const diff = diffEvent(u.content, name);
          if (diff) this.onEvent?.("diff", diff);
        }
        return;
      }
      case "tool_call_update":
        return this._onToolUpdate(u);
      case "plan":
        return this._onPlan(u);
      case "usage_update": {
        // The window fill; per-turn totals arrive on the prompt's answer.
        if (u.used) this.stats.contextTokens = u.used;
        if (u.size) this.stats.contextWindow = u.size;
        this.onEvent?.("stats", { stats: this.stats });
        return;
      }
      case "available_commands_update": {
        const commands = (Array.isArray(u.availableCommands) ? u.availableCommands : [])
          .map((c) => ({ name: String(c.name || ""), description: String(c.description || c.input?.hint || "") }))
          .filter((c) => c.name);
        if (commands.length) {
          this.metadata.commands = commands;
          this._emitInit();
        }
        return;
      }
      case "current_mode_update":
        if (u.currentModeId && u.currentModeId !== this.metadata.permissionMode) {
          this.metadata.permissionMode = u.currentModeId;
          this._emitInit();
        }
        return;
      default:
        // Undrawn records still travel whole — the pane re-renders the TUI, it does not summarize it.
        this.onEvent?.("cli_event", { type: u.sessionUpdate || "", subtype: "", record: u });
    }
  }

  _onToolUpdate(u) {
    const call = this.toolCalls.get(u.toolCallId);
    if (!call) return;
    if (u.status === "failed") {
      this.toolCalls.delete(u.toolCallId);
      const error = contentText(u.content) || "Tool failed.";
      this.onEvent?.("tool_result", { id: u.toolCallId, name: call.name, error, status: "error" });
      return;
    }
    if (u.status !== "completed") {
      // in_progress frames stream partial output; the pane has no live row feed —
      // the completed frame settles the card whole.
      return;
    }
    this.toolCalls.delete(u.toolCallId);
    this.onEvent?.("tool_result", { id: u.toolCallId, name: call.name, output: contentText(u.content) || String(u.rawOutput || ""), status: "done" });
    // Only a change that LANDED is a diff; a denied one stays the row it already is.
    if (call.kind === "edit") {
      const diff = diffEvent(u.content, call.name);
      if (diff) this.onEvent?.("diff", diff);
    }
  }

  // The wire sends the whole plan each time (todo_list → plan entries) — replay
  // it as the todo tool pair every engine's task strip already understands.
  _onPlan(u) {
    const todos = (Array.isArray(u.entries) ? u.entries : [])
      .map((e) => ({ content: String(e?.content || "").trim(), status: e?.status || "pending" }))
      .filter((t) => t.content);
    if (!todos.length) return;
    const id = `hermes-plan-${this._planSeq++}`;
    this.onEvent?.("tool_start", { id, name: "todo_list", input: { todos }, status: "running" });
    this.onEvent?.("tool_result", { id, name: "todo_list", output: "", status: "done" });
  }

  _finishTurn(result) {
    // A missing stopReason still settles the turn — bailing here would wedge
    // isTurnRunning on a malformed answer and block every later prompt.
    this.isTurnRunning = false;
    // The turn is over: any gate left is unanswerable, and a replayed one returns as a stuck card.
    this.pendingRequests.clear();
    const usage = result?.usage || {};
    this.stats.inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0;
    this.stats.outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0;
    this.stats.cachedTokens = usage.cachedReadTokens ?? usage.cached_read_tokens ?? 0;
    this.stats.reasoningTokens = usage.thoughtTokens ?? usage.thought_tokens ?? usage.reasoning_tokens ?? 0;
    this.stats.totalTurns += 1;
    // An effort pick that arrived mid-turn applies now, in the idle window it needs.
    const apply = this._pendingEffortApply;
    this._pendingEffortApply = null;
    if (apply) apply();
    this._scheduleTitleRefresh();
    const stop = String(result?.stopReason || "end_turn");
    // The stop word rides the sentence — the row used to say only the generic "ended in an
    // error" while the actual reason sat unread in `subtype`.
    const failed = stop !== "end_turn" && stop !== "cancelled";
    this.onEvent?.("turn_complete", {
      stats: this.stats,
      result: failed ? `The turn stopped early (${stop}).` : "",
      isError: failed,
      subtype: stop
    });
  }

  // Hermes titles the session itself (state.db, a beat after the turn ends) —
  // adopt it so the pane header names the chat like the TUI does.
  _scheduleTitleRefresh() {
    if (this._titleTimer || this._titledSession === this.activeSessionId) return;
    this._titleTimer = setTimeout(() => {
      this._titleTimer = null;
      this._refreshTitle();
    }, TITLE_FETCH_DELAY_MS);
  }

  _refreshTitle() {
    if (!this.activeSessionId || this._titledSession === this.activeSessionId) return;
    const title = readHermesSessionTitle(this.activeSessionId);
    this._titledSession = this.activeSessionId;
    if (!title || title === this.metadata.threadName) return;
    this.metadata.threadName = title.slice(0, 80);
    this._emitInit();
  }

  // ACP has no rename, so the write goes straight into state.db beside the reader.
  renameThread(name) {
    const ok = renameHermesSession(this.activeSessionId, name);
    if (ok) {
      this._titledSession = this.activeSessionId;
      this.metadata.threadName = name.slice(0, 80);
      this._emitInit();
    }
    return ok;
  }
}
