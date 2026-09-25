// Adapter for omp (oh-my-pi) driven headlessly over `omp --mode rpc`: one
// long-lived NDJSON process per chat, daemon-owned so it survives restarts.
// AgentSessionEvent frames normalize into the pane's shared vocabulary; the
// '/' menu rides available_commands_update; approval and ask-style dialogs ride
// extension_ui_request (wire shapes measured from .source/omp, 18.2.6).
import { DaemonProc } from "../proc/daemonProc.js";
import { createLogger } from "../../../lib/logger.js";
import { stageAttachment } from "../aiAttachment.js";
import { OmpRpcClient } from "../ompRpcClient.js";
import { diffFor } from "../opencodePart.js";
import { getExtendedEnv } from "./env.js";

const logger = createLogger("ai");

// 9Remote's two modes onto omp's approval tiers; applied at spawn (launch flag).
const OMP_APPROVAL_MODES = { default: "always-ask", auto: "yolo" };

const toolOutput = (result) =>
  (Array.isArray(result?.content) ? result.content : [])
    .map((c) => (c?.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
  || (result?.details != null ? String(result.details) : "");

export class OmpAdapter {
  constructor({ cwd, onEvent, proc = null, sessionId = null, model = "", hostSessionId = null } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.hostSessionId = hostSessionId;
    this.proc = proc || new DaemonProc({ procId: "" });
    this.activeSessionId = sessionId || null;
    this._resumeId = sessionId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.permissionMode = "default";
    this.effort = "";
    this.rpc = null;
    this.pendingRequests = new Map(); // id → {toolName, input, kind}
    this.stats = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTurns: 0 };
    this.metadata = { model: this.currentModel, sessionId: this.activeSessionId || "", permissionMode: this.permissionMode, effort: this.effort };
    this._toolArgs = new Map();
    // A mode-change recycle in flight: the next spawn waits for it (see setOptions).
    this._stopping = null;
  }

  // Non-fatal adapter problem: a warning row, never an `error` event (those
  // release the running turn).
  _warn(message) {
    this.onEvent?.("cli_event", { type: "warning", record: { message } });
  }

  _args() {
    const args = ["--mode", "rpc-ui"];
    if (this.currentModel) args.push("--model", this.currentModel);
    args.push("--approval-mode", OMP_APPROVAL_MODES[this.permissionMode] || "yolo");
    if (this._resumeId) args.push("--resume", this._resumeId);
    return args;
  }

  async _ensureStarted() {
    if (this.rpc) return;
    // A mode change may still be tearing the old process down; start only once free.
    if (this._stopping) { await this._stopping; this._stopping = null; }
    this.proc.onExit = ({ code, error }) => {
      this.rpc = null;
      const wasRunning = this.isTurnRunning;
      this.isTurnRunning = false;
      if (error) this.onEvent?.("error", { message: error });
      else if (wasRunning) this.onEvent?.("turn_complete", { stats: this.stats, result: "", isError: code !== 0, subtype: "" });
    };
    const started = await this.proc.start({ bin: "omp", args: this._args(), cwd: this.cwd, env: getExtendedEnv({ hostSessionId: this.hostSessionId }), keepStdin: true });
    this.rpc = new OmpRpcClient({ proc: this.proc });
    this.rpc.onFrame = (frame) => this._onFrame(frame);
    // DaemonProc holds the spawn's lines until committed — skip it and the
    // ready frame starves and every later line stays held (audited).
    started.commit?.((line) => this.rpc.feed(line));
    // Subagent rows ride the lifecycle feed — opt in once the pipe is live.
    this.rpc.send("set_subagent_subscription", { level: "progress" }, { timeoutMs: 10000 }).catch(() => {});
    this._refreshModels();
    this._syncState();
  }

  _syncState() {
    this.rpc?.send("get_state", {}, { timeoutMs: 10000 })
      .then((state) => {
        if (!state) return;
        if (state.sessionId && state.sessionId !== this.activeSessionId) {
          this.activeSessionId = state.sessionId;
          this.metadata.sessionId = state.sessionId;
        }
        this.isTurnRunning = Boolean(state.isStreaming);
        this.metadata.effort = state.thinkingLevel || this.metadata.effort;
        this.onEvent?.("init", { ...this.metadata });
      })
      .catch(() => {});
  }

  _refreshModels() {
    this.rpc?.send("get_available_models", {}, { timeoutMs: 30000 })
      .then((data) => {
        const models = Array.isArray(data?.models) ? data.models : [];
        if (!models.length) return;
        this.metadata.modelOptions = models
          .filter((m) => m?.id && m?.provider)
          .map((m) => {
            const displayLabel = m.provider === "9router" ? m.id : (m.name || `${m.provider}/${m.id}`);
            return {
              id: `${m.provider}/${m.id}`,
              provider: m.provider,
              label: displayLabel,
              short: displayLabel,
              desc: "",
              // The RPC shape nests levels under thinking.efforts (unlike `omp models --json`).
              efforts: Array.isArray(m.thinking?.efforts) ? m.thinking.efforts : [],
              defaultEffort: "",
              contextWindow: m.contextWindow || m.limit?.context || 0
            };
          })
          // Same order as listOmpModelOptions so the runtime refresh does not reshuffle the picker.
          .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
        this.onEvent?.("init", { ...this.metadata });
      })
      .catch(() => {});
  }

  setOptions({ model, effort, mode, resume } = {}) {
    if (model && model !== this.currentModel) {
      this.currentModel = model;
      this.metadata.model = model;
      if (this.rpc) {
        const [provider, ...rest] = model.split("/");
        if (provider && rest.length) {
          this.rpc.send("set_model", { provider, modelId: rest.join("/") }, { timeoutMs: 15000 })
            .catch((e) => this._warn(`Could not set the OMP model: ${e.message}`));
        }
      }
    }
    if (effort && effort !== this.effort) {
      this.effort = effort;
      this.metadata.effort = effort;
      this.rpc?.send("set_thinking_level", { level: effort }, { timeoutMs: 10000 }).catch(() => {});
    }
    if (mode && mode !== this.permissionMode) {
      this.permissionMode = mode;
      this.metadata.permissionMode = mode;
      // --approval-mode is a launch flag with no runtime RPC: recycle the process
      // so the next prompt spawns under the new tier, resuming this conversation.
      if (this.rpc) {
        this._resumeId = this.activeSessionId || this._resumeId;
        this.rpc.close();
        this.rpc = null;
        this._stopping = this.proc.stop().catch(() => {});
        this._warn("OMP mode changed — its process restarts to apply.");
      }
    }
    if (resume && resume !== this.activeSessionId) {
      this._resumeId = resume;
      if (!this.rpc) this.activeSessionId = resume;
    }
    this.onEvent?.("init", { ...this.metadata });
  }

  static doctorSpec() {
    return { command: "omp", args: ["--version"] };
  }

  // Re-attach to the still-running process after an agent restart.
  async adopt(from = 0, epoch = null) {
    const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
    const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
    const fetch = await this.proc.attach(f, ep);
    if (!fetch.alive) return fetch;
    // The process kept running; rebuild the client on the same pipe.
    this.rpc = new OmpRpcClient({ proc: this.proc });
    this.rpc.onFrame = (frame) => this._onFrame(frame);
    // The attach result holds the gap's lines until committed — same trap as start.
    fetch.commit?.((line) => this.rpc.feed(line));
    this._syncState();
    this._refreshModels();
    return fetch;
  }

  sendPrompt(promptText, attachments = null) {
    if (this.isTurnRunning) throw new Error("OMP turn is already running.");
    this.isTurnRunning = true;
    const staged = attachments?.length ? attachments.map(stageAttachment) : null;
    const images = (staged || []).filter((a) => a.kind === "image");
    Promise.resolve()
      .then(() => this._ensureStarted())
      .then(() => this.rpc.send("prompt", {
        message: [promptText].filter(Boolean).join(" ") || " ",
        ...(images.length
          ? { images: images.map((a) => ({ type: "image", data: a.data, mimeType: a.mediaType })) }
          : {})
      }, { timeoutMs: 600000 }))
      .catch((e) => {
        this.isTurnRunning = false;
        this.onEvent?.("error", { message: e.message });
      });
  }

  // The '/' menu rides the command feed; omp itself interprets "/name args".
  feed() {}

  // omp's own rename (source "user", so later auto-naming cannot overwrite it).
  // Never spawns: a rename is not worth resurrecting a stopped process, and a
  // fresh spawn would name some brand-new empty session instead.
  async renameThread(name) {
    if (!this.rpc) return false;
    await this.rpc.send("set_session_name", { name }, { timeoutMs: 10000 });
    return true;
  }

  interrupt() {
    // A stop may arrive after the engine already ended the turn (a missed
    // agent_end leaves the pane "working"): abort is idempotent server-side
    // (agent-session abort just drains controllers/queues), so send it anyway
    // rather than strand the pane behind a refused stop.
    const sent = this.rpc != null;
    this.isTurnRunning = false;
    if (sent) this.rpc.send("abort", {}, { timeoutMs: 10000 }).catch((e) => logger.warn(`omp abort refused: ${e.message}`));
    return sent;
  }

  signal(sig = "SIGINT") {
    // rpc-less fallback: the daemon routes the signal to the real process.
    if (this.rpc) return this.interrupt();
    if (typeof this.proc?.signal !== "function") return false;
    try { this.proc.signal(sig); return true; } catch { return false; }
  }

  stop() {
    this.isTurnRunning = false;
    this.rpc?.close();
    this.rpc = null;
    // The daemon-held process IS the conversation: closing the pipe alone leaves
    // `omp --mode rpc` running forever with nobody reading its frames (same leak
    // the opencode serve server had before its refcount). A recycle already in
    // flight is awaited instead of double-stopping.
    const stopping = this._stopping || this.proc.stop().catch(() => {});
    this._stopping = stopping;
    return stopping;
  }

  // ── rewind (conversation only: the session tree branches in place) ─────────
  async branchPoints() {
    const data = await this.rpc?.send("get_branch_messages", {}, { timeoutMs: 15000 });
    return (Array.isArray(data?.messages) ? data.messages : [])
      .map((m) => ({ messageId: m.entryId, text: String(m.text || "") }));
  }

  async rewindConversation(entryId) {
    if (!entryId) return { rewound: false, error: "No turn to rewind to." };
    try {
      await this.rpc.send("branch", { entryId }, { timeoutMs: 15000 });
      return { rewound: true };
    } catch (e) {
      return { rewound: false, error: e.message };
    }
  }

  // ── gates ──────────────────────────────────────────────────────────────────
  resolvePermission(requestId, behavior) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    this.pendingRequests.delete(requestId);
    if (pending.kind === "approval") {
      this.rpc?.uiRespondValue(requestId, behavior === "allow" ? "Approve" : "Deny");
      return true;
    }
    this.rpc?.uiRespondCancel(requestId);
    return true;
  }

  resolveQuestion(requestId, answers = {}) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    this.pendingRequests.delete(requestId);
    if (pending.kind === "confirm") {
      const yes = Object.values(answers)[0];
      this.rpc?.uiRespondConfirm(requestId, [].concat(yes)[0] === "Yes");
      return true;
    }
    const value = pending.kind === "input"
      ? String([].concat(Object.values(answers)[0] ?? "").join(" "))
      : String([].concat(Object.values(answers)[0] ?? [])[0] ?? "");
    this.rpc?.uiRespondValue(requestId, value);
    return true;
  }

  // ── frame normalization ────────────────────────────────────────────────────
  _onFrame(frame) {
    const type = frame?.type;
    if (type === "message_update") return this._onMessageUpdate(frame);
    if (type === "message_end") return this._onMessageEnd(frame);
    if (type === "tool_execution_start") {
      this._toolArgs.set(frame.toolCallId, frame.args || {});
      this.onEvent?.("tool_start", { id: frame.toolCallId, name: frame.toolName || "tool", input: frame.args || {}, status: "running" });
      return;
    }
    if (type === "tool_execution_end") {
      const name = frame.toolName || "tool";
      const failed = Boolean(frame.isError || frame.result?.isError);
      const output = toolOutput(frame.result);
      if (failed) this.onEvent?.("tool_result", { id: frame.toolCallId, name, error: output || "Tool failed.", status: "error" });
      else {
        this.onEvent?.("tool_result", { id: frame.toolCallId, name, output, status: "done" });
        // omp's write names {path, content} — the same fold opencode's uses.
        if (name === "write" || name === "edit") {
          const diff = diffFor(name, this._toolArgs.get(frame.toolCallId) || {});
          if (diff) this.onEvent?.("diff", diff);
        }
        if (name === "todo") {
          const phases = Array.isArray(frame.result?.details?.phases) ? frame.result.details.phases : [];
          const todos = phases.flatMap((p) => p.tasks || []).map((t) => ({ content: t.content, status: t.status }));
          if (todos.length) {
            this.onEvent?.("tool_start", { id: `todo-upd-${frame.toolCallId}`, name: "todowrite", input: { todos }, status: "running" });
            this.onEvent?.("tool_result", { id: `todo-upd-${frame.toolCallId}`, name: "todowrite", output: "", status: "done" });
          }
        }
      }
      this._toolArgs.delete(frame.toolCallId);
      return;
    }
    if (type === "agent_end") {
      if (frame.isTerminal === false) return; // more work already scheduled
      this.isTurnRunning = false;
      this.stats.totalTurns += 1;
      this.onEvent?.("turn_complete", { stats: this.stats, result: "", isError: false, subtype: "" });
      return;
    }
    if (type === "prompt_result" && frame.agentInvoked === false) {
      // A local-only command finished without an agent loop behind it.
      this.isTurnRunning = false;
      this.onEvent?.("turn_complete", { stats: this.stats, result: "", isError: false, subtype: "" });
      return;
    }
    if (type === "available_commands_update") {
      const commands = (Array.isArray(frame.commands) ? frame.commands : [])
        .map((c) => ({ name: String(c.name || ""), description: String(c.description || c.input?.hint || "") }))
        .filter((c) => c.name);
      this.metadata.commands = commands;
      this.onEvent?.("init", { ...this.metadata });
      return;
    }
    if (type === "session_info_update") {
      if (frame.sessionId && frame.sessionId !== this.activeSessionId) {
        this.activeSessionId = frame.sessionId;
        this.metadata.sessionId = frame.sessionId;
        this.onEvent?.("init", { ...this.metadata });
      }
      return;
    }
    if (type === "config_update") {
      if (frame.model) this.metadata.model = frame.model;
      if (frame.thinkingLevel) this.metadata.effort = frame.thinkingLevel;
      this.onEvent?.("init", { ...this.metadata });
      return;
    }
    if (type === "command_output") {
      this.onEvent?.("cli_event", { type: "system", subtype: "local_command", record: { content: String(frame.text || ""), level: "info" } });
      return;
    }
    if (type === "notice") {
      this.onEvent?.("cli_event", { type: "warning", record: { message: String(frame.message || "") } });
      return;
    }
    if (type === "auto_compaction_start") {
      this.onEvent?.("cli_event", { type: "system", subtype: "status", record: { status: "compacting" } });
      return;
    }
    if (type === "auto_compaction_end") {
      this.onEvent?.("cli_event", { type: "thread/compacted", record: {} });
      return;
    }
    if (type === "auto_retry_start") {
      this.onEvent?.("cli_event", { type: "warning", record: { message: `Retrying (attempt ${frame.attempt ?? "?"}/${frame.maxAttempts ?? "?"}): ${frame.errorMessage || ""}` } });
      return;
    }
    if (type === "subagent_lifecycle") return this._onSubagent(frame);
    if (type === "extension_ui_request") return this._onUiRequest(frame);
    if (type === "rpc_frame_error") {
      this.onEvent?.("error", { message: `OMP frame dropped: ${frame.error || "transport limit"}` });
      return;
    }
    if (type === "extension_error") {
      this._warn(`OMP extension error: ${frame.error?.message || frame.error || "unknown"}`);
      return;
    }
    // turn_start, agent_start, tool progress frames: nothing the pane draws.
  }

  _onMessageUpdate(frame) {
    const e = frame.assistantMessageEvent || {};
    if (e.type === "text_delta" && e.delta) this.onEvent?.("delta", { text: e.delta });
    else if (e.type === "thinking_delta" && e.delta) this.onEvent?.("thinking", { text: e.delta });
    else if (e.type === "error") {
      this.isTurnRunning = false;
      this.onEvent?.("error", { message: e.error?.errorMessage || "The OMP turn failed." });
    }
  }

  _onMessageEnd(frame) {
    const msg = frame.message || {};
    if (msg.role !== "assistant") return;
    const usage = msg.usage || {};
    this.stats.inputTokens += usage.input || 0;
    this.stats.outputTokens += usage.output || 0;
    this.stats.reasoningTokens += usage.reasoningTokens || usage.reasoning || 0;
    this.stats.contextTokens = usage.contextTokens || usage.input || this.stats.contextTokens || 0;
    this.onEvent?.("stats", { stats: this.stats });
  }

  _onSubagent(frame) {
    const p = frame.payload || {};
    const id = p.id || p.sessionFile || `sub-${p.index ?? 0}`;
    const description = p.description || p.task || p.agent || "subagent";
    if (p.status === "started") {
      this.onEvent?.("cli_event", { type: "system", subtype: "task_started", task_id: id, description, record: { type: "system", subtype: "task_started", task_id: id, description, is_backgrounded: true } });
    } else {
      const status = p.status === "completed" ? "completed" : "failed";
      this.onEvent?.("cli_event", { type: "system", subtype: "task_notification", task_id: id, record: { type: "system", subtype: "task_notification", task_id: id, status } });
    }
  }

  _onUiRequest(frame) {
    const id = frame.id;
    if (frame.method === "cancel") {
      this.pendingRequests.delete(frame.targetId);
      this.onEvent?.("permission_resolved", { requestId: frame.targetId });
      return;
    }
    if (frame.method === "notify") {
      this.onEvent?.("cli_event", { type: "warning", record: { message: String(frame.message || "") } });
      return;
    }
    if (frame.method === "select") {
      const options = Array.isArray(frame.options) ? frame.options : [];
      // Tool approval: exactly Approve/Deny over an "Allow tool: <name>" title.
      if (/^Allow tool:/i.test(String(frame.title || "")) && options.includes("Approve") && options.includes("Deny")) {
        const tool = String(frame.title).split("\n")[0].replace(/^Allow tool:\s*/i, "").trim() || "tool";
        this.pendingRequests.set(id, { toolName: tool, input: { title: frame.title }, kind: "approval" });
        this.isTurnRunning = true;
        this.onEvent?.("permission_request", { requestId: id, tool, input: { title: frame.title }, type: "permission" });
        return;
      }
      const question = String(frame.title || "Choose");
      this.pendingRequests.set(id, { toolName: "AskUserQuestion", kind: "question", questions: [question] });
      this.isTurnRunning = true;
      this.onEvent?.("permission_request", {
        requestId: id,
        tool: "AskUserQuestion",
        input: {
          questions: [{
            question,
            header: question.slice(0, 30),
            options: options.map((label, i) => ({ label: String(label), description: frame.optionDetails?.[i]?.description || "" }))
          }]
        },
        type: "permission"
      });
      return;
    }
    if (frame.method === "confirm") {
      const question = String(frame.message || frame.title || "Confirm?");
      this.pendingRequests.set(id, { toolName: "AskUserQuestion", kind: "confirm", questions: [question] });
      this.isTurnRunning = true;
      this.onEvent?.("permission_request", {
        requestId: id,
        tool: "AskUserQuestion",
        input: { questions: [{ question, header: String(frame.title || "").slice(0, 30), options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }] },
        type: "permission"
      });
      return;
    }
    if (frame.method === "input") {
      const question = String(frame.title || "Input");
      this.pendingRequests.set(id, { toolName: "AskUserQuestion", kind: "input", questions: [question] });
      this.isTurnRunning = true;
      this.onEvent?.("permission_request", {
        requestId: id,
        tool: "AskUserQuestion",
        input: { questions: [{ question, header: question.slice(0, 30), isOther: true }] },
        type: "permission"
      });
    }
  }
}
