// Adapter for the Devin CLI (`devin acp`): one long-lived ACP JSON-RPC process
// per chat, daemon-owned so it survives agent restarts. A saved conversation
// reopens on a fresh process via session/load (model change, adopt). Wire
// shapes measured from devin 3000.11.1 — standard JSON-RPC framing, so the
// stock JsonRpcClient speaks it unmodified.
import { DaemonProc, decodeLine } from "../proc/daemonProc.js";
import { JsonRpcClient } from "../proc/jsonRpcClient.js";
import { stageAttachment, buildAttachedPrompt } from "../aiAttachment.js";
import { buildEditDiff, buildEditPatch } from "./claudeAdapter.js";
import { getExtendedEnv } from "./env.js";
import { createLogger } from "../../../lib/logger.js";

const logger = createLogger("ai");

const HANDSHAKE_TIMEOUT_MS = 60000;
const PROMPT_TIMEOUT_MS = 600000;

// Text out of an ACP content list: items nest the payload under `content`.
const contentText = (content) => (Array.isArray(content) ? content : [])
  .map((c) => c?.content?.text ?? c?.text ?? "")
  .filter(Boolean)
  .join("\n");

// An edit lands as rawInput {file_path, old_string, new_string} (Claude's shape
// — buildEditDiff is reused whole); the streamed diff block is the fallback.
function editDiff(update, input) {
  const diff = buildEditDiff("Edit", input || {});
  if (diff?.file) return diff;
  const d = (Array.isArray(update.content) ? update.content : []).find((c) => c?.type === "diff" && c.path);
  if (!d) return null;
  return { file: d.path, name: "Edit", patch: buildEditPatch("Edit", { old_string: d.oldText, new_string: d.newText }), content: "" };
}

export class DevinAdapter {
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
    this.stats = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTurns: 0, contextTokens: 0, contextWindow: 0 };
    this.metadata = { model: this.currentModel, sessionId: this.activeSessionId || "", permissionMode: "accept-edits", commands: [] };
    // A recycle in flight (model change): the next spawn waits for it.
    this._stopping = null;
  }

  // Non-fatal adapter problem: a warning row, never an `error` event (those
  // release the running turn).
  _warn(message) {
    this.onEvent?.("cli_event", { type: "warning", record: { message } });
  }

  async _ensureStarted() {
    if (this.rpc) return;
    // A recycle may still be tearing the old process down; start only once free.
    if (this._stopping) { await this._stopping; this._stopping = null; }
    const started = await this.proc.start({
      bin: "devin",
      args: ["acp", ...(this.currentModel ? ["--model", this.currentModel] : [])],
      cwd: this.cwd,
      env: getExtendedEnv({ hostSessionId: this.hostSessionId }),
      keepStdin: true
    });
    // Standard JSON-RPC envelope — the stock codecs speak ACP as-is; id can be a
    // UUID string (permission requests), which the default extractors accept.
    this.rpc = new JsonRpcClient(this.proc, { onMessage: (m) => this.handleFrame(m) });
    this.rpc.on("session/request_permission", (params, id) => this._onPermission(params, id));
    this.rpc.onExit((info) => this._handleExit(info));
    // DaemonProc holds the spawn's lines until committed — skip it and the
    // initialize answer starves (audited; same trap as omp).
    started.commit?.((line) => this.rpc.feed(line));
    await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    }, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
    const params = { cwd: this.cwd, mcpServers: [] };
    let session = null;
    if (this._resumeId) {
      // A resume id the CLI no longer holds (wiped data, other machine) must not
      // wedge the pane: fall through to a fresh conversation and say so.
      try {
        session = await this.rpc.request("session/load", { ...params, sessionId: this._resumeId }, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
      } catch {
        this._resumeId = null;
        this._warn("Devin no longer has that conversation — starting a new one.");
      }
    }
    session ||= await this.rpc.request("session/new", params, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
    this.activeSessionId = this._resumeId = session.sessionId || this._resumeId;
    this.metadata.sessionId = this.activeSessionId || "";
    if (session.modes?.currentModeId) this.metadata.permissionMode = session.modes.currentModeId;
    this.onEvent?.("init", { ...this.metadata });
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
    else if (wasRunning) this.onEvent?.("turn_complete", { stats: this.stats, result: code != null && code !== 0 ? `Devin exited (code ${code}).` : signal ? `Devin was killed (${signal})` : "", isError: (code != null && code !== 0) || Boolean(signal), subtype: "exit" });
  }

  setOptions({ model, resume } = {}) {
    if (model && model !== this.currentModel) {
      // Measured: --model is spawn-level only, the wire has no switch call, and a
      // free account's config offers exactly one model (the catalog lists 390 the
      // account cannot run). Say so instead of recycling into the same outcome.
      this.currentModel = model;
      if (!this.rpc) {
        this.metadata.model = model;
      } else if (this._modelOptions?.length && !this._modelOptions.includes(model)) {
        this._warn(`This Devin account only offers: ${this._modelOptions.join(", ")} — keeping ${this.metadata.model}.`);
      } else {
        this._warn("Devin applies a new model on Restart AI — this conversation keeps its own.");
      }
    }
    if (resume && resume !== this._resumeId) {
      this._resumeId = resume;
      if (!this.rpc) {
        this.activeSessionId = resume;
        this.metadata.sessionId = resume;
      } else {
        // The live process holds the OLD conversation, and the wire has no switch
        // method: recycle so the next spawn session/loads the resumed one.
        this.activeSessionId = resume;
        this.metadata.sessionId = resume;
        this.rpc.close();
        this.rpc = null;
        this._stopping = this.proc.stop().catch(() => {});
        this._warn("Devin conversation switched — its process restarts to apply.");
      }
    }
    this.onEvent?.("init", { ...this.metadata });
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "devin", args: ["doctor"] };
  }

  // Re-attach to the still-running process after an agent restart.
  async adopt(from = 0, epoch = null) {
    const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
    const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
    const fetch = await this.proc.attach(f, ep);
    if (!fetch.alive) return fetch;
    this.rpc = new JsonRpcClient(this.proc, { onMessage: (m) => this.handleFrame(m) });
    this.rpc.on("session/request_permission", (params, id) => this._onPermission(params, id));
    this.rpc.onExit((info) => this._handleExit(info));
    // The gap's lines are NOT committed here: _replay commits each buffer exactly
    // once (a second commit replays the same array again), and its door is
    // adapter.feed — leaving every replayed frame one delivery, not two.
    this.isTurnRunning = this._midTurn(fetch.lines);
    return fetch;
  }

  // Mid-turn iff the last meaningful frame is streaming output, not the prompt's
  // answer: the process idles between turns, so `alive` alone is not a turn.
  _midTurn(lines = []) {
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec;
      try { rec = JSON.parse(decodeLine(lines[i])); } catch { continue; }
      if (rec?.result?.stopReason) return false;
      if (rec?.method === "session/update" || (typeof rec?.method === "string" && rec.method.startsWith("_cognition.ai/"))) return true;
    }
    return false;
  }

  sendPrompt(promptText, attachments = null) {
    if (this.isTurnRunning) throw new Error("Devin turn is already running.");
    const staged = attachments?.length ? attachments.map(stageAttachment) : null;
    const images = (staged || []).filter((a) => a.kind === "image");
    const prompt = [
      { type: "text", text: buildAttachedPrompt(promptText, staged) },
      ...images.map((a) => ({ type: "image", data: a.data, mimeType: a.mediaType }))
    ];
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

  // The '/' menu rides the command feed; devin itself interprets "/name args".
  feed(line) {
    // Replay-only door, independent of the rpc (a dead process has none): parse
    // and dispatch straight — live lines reach handleFrame through the client.
    let msg = null;
    try { msg = JSON.parse(String(line)); } catch { return; }
    if (msg?.result?.stopReason) return this._finishTurn(msg.result);
    if (msg?.method === "session/request_permission" && msg.id != null) {
      return this._onPermission(msg.params || {}, msg.id);
    }
    this.handleFrame(msg);
  }

  interrupt() {
    if (!this.rpc) return false;
    this.isTurnRunning = false;
    // Idempotent server-side: send even if the turn already ended so a missed
    // stop never strands the pane — same stance as omp's abort.
    this.rpc.notify("session/cancel", { sessionId: this.activeSessionId });
    return true;
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
    // The daemon-held process IS the conversation; a recycle already in flight
    // is awaited instead of double-stopping.
    const stopping = this._stopping || this.proc.stop().catch(() => {});
    this._stopping = stopping;
    return stopping;
  }

  // ── gates ──────────────────────────────────────────────────────────────────
  _onPermission(params, id) {
    const toolCall = params?.toolCall || {};
    const command = toolCall._meta?.["cognition.ai/editableCommand"] || "";
    this.isTurnRunning = true;
    this.pendingRequests.set(id, { options: Array.isArray(params?.options) ? params.options : [] });
    this.onEvent?.("permission_request", {
      requestId: id,
      tool: command ? "exec" : "tool",
      input: command ? { command } : { toolCallId: toolCall.toolCallId || "" },
      type: "permission"
    });
  }

  // The card offers Allow/Deny; the wire's allow_session/allow_always tiers are
  // the TUI's to remember — one-shot is the honest pane mapping.
  resolvePermission(requestId, behavior) {
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    if (!pending) return false;
    const optionId = behavior === "allow" ? "allow_once" : "reject_once";
    const option = pending.options.find((o) => o?.optionId === optionId || o?.kind === optionId);
    this.rpc?.respond(requestId, { outcome: { outcome: "selected", optionId: option?.optionId || optionId } });
    return true;
  }

  // No ask-style dialogs on this wire (MCP elicitation aside) — the honest answer.
  resolveQuestion() {
    return false;
  }

  // ── frames ─────────────────────────────────────────────────────────────────
  handleFrame(m) {
    if (!m || typeof m !== "object") return;
    if (m.method === "session/update") return this._onUpdate(m.params?.update || {});
    // Vendor channels: `output` is log noise, `thinking_complete` closes a block
    // the pane already follows by stream — the rest travel whole.
    if (typeof m.method === "string" && m.method.startsWith("_cognition.ai/")) {
      if (m.method === "_cognition.ai/output" || m.method === "_cognition.ai/thinking_complete") return;
      this.onEvent?.("cli_event", { type: m.method, subtype: "", record: m.params || {} });
      return;
    }
    // A replayed prompt answer (live ones settle inside the request call).
    if (m.result?.stopReason) return this._finishTurn(m.result);
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
      case "tool_call": {
        const id = u.toolCallId || `devin-${this._toolSeq++}`;
        const name = u._meta?.["cognition.ai/inferenceToolName"] || u.kind || "tool";
        this.toolCalls.set(id, { name, kind: u.kind || "", input: u.rawInput || {} });
        this.isTurnRunning = true;
        this.onEvent?.("tool_start", { id, name, input: u.rawInput || {}, status: "running" });
        return;
      }
      case "tool_call_update":
        return this._onToolUpdate(u);
      case "usage_update":
        // The window fill; per-turn totals arrive on the prompt's answer.
        if (u.used) this.stats.contextTokens = u.used;
        if (u.size) this.stats.contextWindow = u.size;
        this.onEvent?.("stats", { stats: this.stats });
        return;
      case "current_mode_update":
        if (u.currentModeId && u.currentModeId !== this.metadata.permissionMode) {
          this.metadata.permissionMode = u.currentModeId;
          this.onEvent?.("init", { ...this.metadata });
        }
        return;
      case "config_option_update": {
        const option = (Array.isArray(u.configOptions) ? u.configOptions : []).find((c) => c?.id === "model");
        // The select's own options are what the ACCOUNT may run — the catalog is not.
        if (Array.isArray(option?.options)) this._modelOptions = option.options.map((o) => o?.value).filter(Boolean);
        if (option?.currentValue && option.currentValue !== this.metadata.model) {
          this.metadata.model = option.currentValue;
          this.onEvent?.("init", { ...this.metadata });
        }
        return;
      }
      case "available_commands_update": {
        const commands = (Array.isArray(u.availableCommands) ? u.availableCommands : [])
          .map((c) => ({ name: String(c.name || ""), description: String(c.description || c.input?.hint || "") }))
          .filter((c) => c.name);
        this.metadata.commands = commands;
        this.onEvent?.("init", { ...this.metadata });
        return;
      }
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
    this.onEvent?.("tool_result", { id: u.toolCallId, name: call.name, output: contentText(u.content), status: "done" });
    // Only a change that LANDED is a diff; a denied one stays the row it already is.
    if (call.kind === "edit") {
      const diff = editDiff(u, call.input);
      if (diff) this.onEvent?.("diff", diff);
    }
  }

  _finishTurn(result) {
    // A missing stopReason still settles the turn — bailing here would wedge
    // isTurnRunning on a malformed answer and block every later prompt.
    this.isTurnRunning = false;
    // The turn is over: any gate left is unanswerable, and a replayed one returns as a stuck card.
    this.pendingRequests.clear();
    const usage = result?.usage || {};
    this.stats.inputTokens = usage.inputTokens || 0;
    this.stats.outputTokens = usage.outputTokens || 0;
    this.stats.cachedTokens = usage.cachedReadTokens || 0;
    this.stats.totalTurns += 1;
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
}
