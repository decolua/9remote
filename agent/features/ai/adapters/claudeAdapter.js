// Claude Code CLI adapter (--input-format=stream-json). Two carriers (direct spawn /
// daemon) share this one parser so the paths cannot drift apart.
import { getExtendedEnv } from "./env.js";
import { stageAttachment } from "../aiAttachment.js";
import { LocalProc } from "../proc/localProc.js";
import { decodeLine } from "../proc/daemonProc.js";
import { claudeBin } from "../constants.js";

// A rewind of a long session is not instant; timeout is opt-in — see JsonRpcClient.request.
const REWIND_CONTROL_TIMEOUT_MS = 60000;
import { asyncHandle, taskNotificationFrom } from "../toolEvent.js";
import { JsonRpcClient } from "../proc/jsonRpcClient.js";

// Records travel to the pane WHOLE under the harness's own field names — every renamed field is a place for pane and TUI to drift.

// Images ride as content blocks; files are staged to disk and named in the text — same shape the terminal path writes.
function buildContent(prompt, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [{ type: "text", text: prompt }];
  }
  const staged = attachments.map(stageAttachment);
  const images = staged.filter((a) => a.kind === "image");
  const paths = staged.filter((a) => a.kind === "file").map((a) => a.path).join(" ");
  return [
    ...images.map((a) => ({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } })),
    { type: "text", text: [paths, prompt].filter(Boolean).join(" ") },
  ];
}

// A `<persisted-output>` frame folds to the path it saved to; exported because the live stream and the replay both collapse it.
export function collapsePersisted(text) {
  const s = String(text || "");
  if (!s.startsWith("<persisted-output>")) return text;
  const m = /saved to: (\S+)/.exec(s);
  return m ? `saved to: ${m[1]}` : "";
}

// Edit tools carry old/new strings, not patches. The client hides their tool rows — the two lists must agree or a file shows twice.
export const DIFF_TOOL_NAMES = Object.freeze(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DIFF_TOOLS = new Set(DIFF_TOOL_NAMES);

/** The file an edit tool targets; each tool names it differently. */
const editFilePath = (input = {}) =>
  input.file_path || input.notebook_path || input.path || "";

// `+`/`-` lines from edit input keep the diff card engine-neutral (Codex sends a real patch); Write returns "" — the card renders `content` as additions.
export function buildEditPatch(name, input = {}) {
  if (name === "Write") return "";
  const edits = name === "MultiEdit" ? input.edits || [] : [input];
  const lines = [];
  for (const edit of edits) {
    if (!edit) continue;
    // A trailing newline would add an empty `-`/`+` line that reads as a real change.
    const add = (text, sign) => {
      const body = String(text).replace(/\n$/, "");
      if (body) lines.push(...body.split("\n").map((l) => `${sign}${l}`));
    };
    add(edit.old_string ?? "", "-");
    add(edit.new_string ?? "", "+");
  }
  return lines.join("\n");
}

export function buildEditDiff(name, input = {}) {
  const file = editFilePath(input);
  if (!file) return null;
  return {
    file,
    name,
    patch: buildEditPatch(name, input),
    content: name === "Write" ? String(input.content || "") : ""
  };
}

export class ClaudeAdapter {
  constructor({ cwd, onEvent, proc = null, hostSessionId = null }) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.hostSessionId = hostSessionId;
    this.proc = proc || new LocalProc();
    this.isTurnRunning = false;
    this.currentMode = "default";
    // Reasoning effort (--effort); empty means the CLI default.
    this.effort = "";
    this.pendingRequests = new Map();
    this.toolCalls = new Map();
    this.turnStreamedText = "";
    this.stats = { totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 0 };
    // Set when OUR interrupt went out: the CLI's `result` echo of it must not end a newer turn; consumed by the echo, never by a prompt.
    this._interrupted = false;
    this.metadata = { model: "", sessionId: "", tools: [], skills: [], slashCommands: [] };
    // Set when the resume id was refused, so the caller drops it instead of retrying a conversation the CLI does not have.
    this.resumeRejected = false;
    this._initializedThisSpawn = false;
    // A prompt held across the respawn so a second refusal cannot start a second rebuild.
    this._respawning = false;
  }

  /** Returns lines emitted before handlers were in place, for the caller to parse first. */
  async start(mode = "default", resumeSessionId = null) {
    this._reset(mode);
    // keepStdin: every later turn and answer rides this same pipe — closing it ends the conversation at birth.
    return await this.proc.start({ bin: claudeBin(), args: this._args(mode, resumeSessionId), cwd: this.cwd, env: getExtendedEnv({ hostSessionId: this.hostSessionId }), keepStdin: true });
  }

  /** Re-attach to the daemon's process from a line offset; `alive:false` means nothing to adopt. */
  async adopt(from = 0, epoch = null) {
    const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
    const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
    this._reset(this.currentMode);
    const fetch = await this.proc.attach(f, ep);
    // A live process is NOT a running turn — this CLI idles between turns; `alive` alone would wedge the flag and block rewinds.
    if (fetch.alive) this.isTurnRunning = this._midTurn(fetch);
    return fetch;
  }

  /** Mid-turn iff the last line is not a `result` record; no lines means nothing to judge by. */
  _midTurn(fetch) {
    const last = fetch?.lines?.[fetch.lines.length - 1];
    if (!last) return false;
    try {
      const record = JSON.parse(decodeLine(last));
      return record.type !== "result";
    } catch {
      return false;
    }
  }

  _reset(mode) {
    this.currentMode = mode;
    this.isTurnRunning = false;
    this.pendingRequests.clear();
    this.toolCalls.clear();
    this.turnStreamedText = "";
    this.resumeRejected = false;
    this._initializedThisSpawn = false;
    // Cleared: a respawn replays old `result` records that would be eaten as an unanswered interrupt's echo.
    this._interrupted = false;
    // Bind before start(): a line can arrive while start() is still awaiting.
    // The RPC client owns the control_request/answer correlation; non-RPC records parse as before via onMessage.
    this.rpc = new JsonRpcClient(this.proc, {
      // Claude spells its envelope `type`/`request_id`, not `jsonrpc`/`id`.
      // extractMethod is null ON PURPOSE: the CLI's `control_request` gate is conversation, not a server request — routing it auto-refused every permission prompt.
      extractId: (m) => (typeof m.id === "number" ? m.id : null),
      extractMethod: (m) => null,
      encodeResponse: (id, result) => ({ type: "control_response", response: { subtype: "success", request_id: id, response: result } }),
      encodeError: (id, message) => ({
        type: "control_response",
        response: { subtype: "error", request_id: id, error: message }
      }),
      // Outgoing messages this CLI spells as its own `type`, not as JSON-RPC methods.
      encodeNotification: (method, params) => ({ type: method, ...params }),
      // Control requests nest the payload under `request`, matching the CLI's own records.
      encodeRequest: (id, method, params) => ({ type: method, request_id: id, request: params }),
      // The id rides inside `response` — the envelope itself says nothing about which request it settles.
      decodeResponse: (m) => ({
        id: m.type === "control_response" ? (m.response?.request_id ?? null) : null,
        error: m.response?.subtype === "error" ? (m.response.error || "request failed") : null,
        result: m.response?.subtype === "error" ? null : m.response?.response
      }),
      // Already a parsed object — no re-serializing just to parse it again.
      onMessage: (msg) => this.handleMessage(msg)
    });
    this.proc.onExit = (info) => this._handleExit(info);
    // A refused write is the only notice of a dead CLI before its exit lands — bound beside onExit so both carriers wire together.
    this.proc.onRefused = () => this._handleRefusal();
  }

  _args(mode, resumeSessionId) {
    const args = [
      "-p",
      "--verbose",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", mode,
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--include-partial-messages",
      "--prompt-suggestions", "true",
    ];
    if (mode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    else args.push("--allow-dangerously-skip-permissions");
    if (this.metadata.model) args.push("--model", this.metadata.model);
    if (this.effort) args.push("--effort", this.effort);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return args;
  }

  /** `resume` is one-shot: kept, every later rebuild would re-bind the thread we just left. */
  async setOptions({ mode, model, resume, effort }) {
    let fetch = null;
    let restartNeeded = false;
    if (model && model !== this.metadata.model) { this.metadata.model = model; restartNeeded = true; }
    if (mode && mode !== this.currentMode) { this.currentMode = mode; restartNeeded = true; }
    // Reasoning effort is a spawn-time flag, so changing it needs a restart.
    if (effort && effort !== this.effort) { this.effort = effort; restartNeeded = true; }
    if (resume && resume !== this.metadata.sessionId) { this.metadata.sessionId = resume; restartNeeded = true; }
    if (restartNeeded) {
      // stop() must not clear the line hook — start() rebinds it right after, and a gap holds every new line.
      await this.proc.stop();
      this.isTurnRunning = false;
      fetch = await this.start(this.currentMode, this.metadata.sessionId || null);
    }
    this.onEvent?.("init", { ...this.metadata, permissionMode: this.currentMode, ...(this.effort ? { effort: this.effort } : {}) });
    return fetch;
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "claude", args: ["doctor"] };
  }

  /** Caller feeds lines in order, so a re-attach cannot interleave old and new. */
  feed(line) {
    if (!String(line).trim()) return;
    let data;
    try { data = JSON.parse(line); } catch {
      this.onEvent?.("ansi", { chunk: line + "\r\n" });
      return;
    }
    this.handleMessage(data);
  }

  /** Not `_handleExit`: the id is about to be rebuilt on, so no `exit` event and no resumeRejected — just drop gates and flag. */
  _handleRefusal() {
    this.isTurnRunning = false;
    this.pendingRequests.clear();
    // Left set, every later refusal returns early and the session goes quietly un-recoverable.
    this._respawning = false;
  }

  _handleExit({ code, error } = {}) {
    this.isTurnRunning = false;
    // Left set, the NEXT dead CLI would also find recovery blocked — silently un-recoverable.
    this._respawning = false;
    // A dead CLI waits on nothing; stale entries keep the idle watchdog stood down.
    this.pendingRequests.clear();
    // Only a FAILED pre-init exit proves the resume id was refused — a clean one emits nothing before the first prompt.
    if (this.metadata.sessionId && !this._initializedThisSpawn && (code || error)) {
      this.resumeRejected = true;
    }
    this.onEvent?.("exit", { code, error });
  }

  handleMessage(data) {
    // Sub-agent events carry their spawner's id, so the UI nests them under that card.
    const parentToolUseId = data.parent_tool_use_id || "";

    if (data.type === "system" && data.subtype === "init") {
      this._initializedThisSpawn = true;
      this.metadata = {
        sessionId: data.session_id || "",
        model: data.model || "",
        tools: data.tools || [],
        skills: data.skills || [],
        slashCommands: data.slash_commands || [],
      };
      // Empty effort means the CLI decides — sending it would wipe the level init published.
      this.onEvent?.("init", { ...this.metadata, ...(this.effort ? { effort: this.effort } : {}) });
      return;
    }

    if (data.type === "stream_event") {
      const event = data.event;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = event.delta.text || "";
        // Output proves a turn: adopted processes never see sendPrompt, and a wrong idle flag lets an option change restart the CLI mid-answer.
        this.isTurnRunning = true;
        this.turnStreamedText += text;
        this.onEvent?.("delta", { text });
      } else if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
        this.isTurnRunning = true;
        this.onEvent?.("thinking", { text: event.delta.thinking });
      } else if (event?.usage?.input_tokens) {
        // Per-step usage is the window's current fill; result.usage sums every step and overstates it.
        const u = event.usage;
        this.stats.contextTokens = (u.input_tokens || 0)
          + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        this.onEvent?.("stats", { stats: this.stats });
      }
      return;
    }

    if (data.type === "control_request") {
      const { request_id, request = {} } = data;
      const toolName = request.tool_name || "";
      const toolInput = request.input || request.tool_input || {};
      // A gate is only ever held mid-turn — adopted-turn proof, like the delta case above.
      this.isTurnRunning = true;
      this.pendingRequests.set(request_id, { toolName, input: toolInput });

      this.onEvent?.("permission_request", {
        requestId: request_id,
        tool: toolName,
        input: toolInput,
        type: request.subtype || "permission"
      });
      return;
    }

    if (data.type === "result") {
      // The echo of OUR stop — swallowed, but state consumed: the CLI considers the turn over (see `_interrupted`).
      if (this._interrupted) {
        this._interrupted = false;
        this.isTurnRunning = false;
        this.pendingRequests.clear();
        return;
      }
      this.isTurnRunning = false;
      // The turn is over: any gate left in the map is unanswerable, and a replayed one returns as a stuck card.
      this.pendingRequests.clear();
      if (data.total_cost_usd) {
        this.stats.totalCost += Number(data.total_cost_usd) || 0;
      }
      // result.usage is THIS turn's count — the window's current fill, unlike modelUsage's running sum.
      if (data.usage) {
        this.stats.inputTokens = data.usage.input_tokens || 0;
        this.stats.outputTokens = data.usage.output_tokens || 0;
        this.stats.cacheReadInputTokens = data.usage.cache_read_input_tokens || 0;
        this.stats.cacheCreationInputTokens = data.usage.cache_creation_input_tokens || 0;
      }
      // modelUsage alone states the window size; the widest across models is what can overflow.
      if (data.modelUsage) {
        let contextWindow = 0;
        for (const usage of Object.values(data.modelUsage)) {
          contextWindow = Math.max(contextWindow, usage?.contextWindow || 0);
        }
        if (contextWindow) this.stats.contextWindow = contextWindow;
      }

      // If no delta text was streamed yet, use data.result as output (e.g. from /cost, /compact)
      if (!this.turnStreamedText && typeof data.result === "string" && data.result.trim()) {
        this.onEvent?.("delta", { text: data.result });
      }

      this.turnStreamedText = "";
      // `error_during_execution` with empty `result` is the CLI reporting an INTERRUPT, not a failure — a real failure names itself in `result`.
      const failed = Boolean(data.is_error) && !(data.subtype === "error_during_execution" && !String(data.result || "").trim());
      this.onEvent?.("turn_complete", {
        stats: this.stats,
        result: data.result,
        isError: failed,
        subtype: data.subtype || ""
      });
      return;
    }

    // Assistant `usage` is zeroed in stream-json — real counts arrive on `result`.
    if (data.type === "assistant" && data.message) {
      const msg = data.message;
      const contents = msg.content || [];
      let rendered = false;
      for (const item of contents) {
        if (item.type === "tool_use") {
          rendered = true;
          // Kept for the diff: `tool_result` carries only the id, not the name/input.
          this.toolCalls.set(item.id, { name: item.name, input: item.input });
          this.onEvent?.("tool_start", {
            id: item.id,
            name: item.name,
            input: item.input,
            parentToolUseId
          });
        } else if (item.type === "text" && item.text) {
          rendered = true;
          if (!this.turnStreamedText) {
            this.turnStreamedText = item.text;
            this.onEvent?.("delta", { text: item.text });
          } else if (item.text.length > this.turnStreamedText.length && item.text.startsWith(this.turnStreamedText)) {
            const remaining = item.text.slice(this.turnStreamedText.length);
            this.turnStreamedText = item.text;
            this.onEvent?.("delta", { text: remaining });
          }
        }
      }
      // Undrawn records still travel whole — the pane re-renders the TUI, it does not summarize it.
      if (!rendered) this.emitCliEvent(data, parentToolUseId);
      return;
    }

    if (data.type === "user" && data.message) {
      const taskNotice = taskNotificationFrom(data);
      if (taskNotice?.data) this.onEvent?.("cli_event", taskNotice.data);

      const contents = data.message.content || [];
      let rendered = false;
      for (const item of contents) {
        if (item.type === "tool_result") {
          rendered = true;
          const isError = Boolean(item.is_error);
          const output = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
          // A launch ack is not a result — reporting it `done` finished the row while the work ran on.
          const async = isError ? null : asyncHandle(output, this.toolCalls.get(item.tool_use_id)?.name || "");
          const call = this.toolCalls.get(item.tool_use_id);
          this.onEvent?.("tool_result", {
            id: item.tool_use_id,
            name: call?.name || "",
            error: isError ? output : "",
            output: !isError ? collapsePersisted(output) : "",
            status: isError ? "error" : async ? "running" : "done",
            ...(async ? { async: true, handle: async.id } : null),
            parentToolUseId
          });
          // The diff comes from the RESULT — a denied edit must not paint itself as landed.
          this.toolCalls.delete(item.tool_use_id);
          if (call && !isError && DIFF_TOOLS.has(call.name)) {
            const diff = buildEditDiff(call.name, call.input);
            if (diff) this.onEvent?.("diff", diff);
          }
        }
      }
      // Undrawn user records (CLI-written or replayed prompts) travel whole.
      if (!rendered) this.emitCliEvent(data, parentToolUseId);
      return;
    }

    // Unclaimed records travel whole under the harness's own name.
    this.emitCliEvent(data, parentToolUseId);
  }

  /** A record no branch above draws, on its way to the pane under the harness's own name. */
  emitCliEvent(data, parentToolUseId = "") {
    this.onEvent?.("cli_event", {
      type: data.type || "",
      subtype: data.subtype || "",
      parentToolUseId,
      record: data
    });
  }

  sendPrompt(prompt, attachments = null) {
    this._send(prompt, attachments, false);
  }

  // The CLI executes a /-prefixed message as its own command, so the rename lands
  // in its session store — no turn state, a command produces no turn to wait for.
  renameThread(name) {
    if (!this.rpc) return false;
    this.rpc.notify("user", { message: { role: "user", content: `/rename ${name}` } });
    return true;
  }

  _send(prompt, attachments, retried) {
    this.isTurnRunning = true;
    this.turnStreamedText = "";
    // Only a REFUSAL re-sends — the daemon turned the write away, so the bytes never arrived. A real exit never re-sends.
    this.rpc.notify(
      "user",
      { message: { role: "user", content: buildContent(prompt, attachments) } },
      () => { if (!retried) this._resendAfterRefusal(prompt, attachments); }
    );
  }

  // Rebuild and re-send ONCE after a refusal (the session survives via --resume); silent — an unasked recovery must not paint a failure, a loop would spin the daemon.
  _resendAfterRefusal(prompt, attachments) {
    if (this.resumeRejected || this._respawning) return;
    this._respawning = true;
    // Deferred: the rebuild swallows `rpc` and rebinds `proc` — it must not run inside a handler those own.
    setTimeout(() => {
      // Wrapped, not chained: start() can throw synchronously, and that inside a setTimeout is an uncaught exception.
      Promise.resolve()
        .then(() => this.start(this.currentMode, this.metadata.sessionId || null))
        .then(
          () => setTimeout(() => {
            this._respawning = false;
            this._send(prompt, attachments, true);
          }, 0),
          (e) => {
            this._respawning = false;
            // Nothing to recover with. Say so — a silent stop here is the stuck pane again.
            this.onEvent?.("error", { message: `The CLI exited and could not be restarted: ${e.message}` });
          }
        );
    }, 0);
  }

  resolvePermission(requestId, behavior, message = "") {
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    // Not waiting any more — answering anyway put a stray success on the pipe for an answer nobody received.
    if (!pending) return false;

    // Through the RPC client so the envelope is spelled in one place, refusal path included.
    this.rpc.respond(requestId, behavior === "allow"
      ? { behavior: "allow", updatedInput: pending.input || {} }
      : { behavior: "deny", message: message || "Permission denied." });
    return true;
  }

  resolveQuestion(requestId, answers = {}) {
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    if (!pending) return false;

    this.rpc.respond(requestId, {
      behavior: "allow",
      updatedInput: {
        questions: pending.input?.questions || [],
        answers: answers || {},
      },
    });
    return true;
  }

  /** Interrupt the TURN — the conversation survives; false lets the caller fall back to a signal. */
  interrupt() {
    try {
      // False when the write did not go out — a `true` against a dead pipe desyncs pane and agent.
      const sent = this.rpc.notify("control_request", {
        request_id: `int-${Date.now()}`,
        request: { subtype: "interrupt", cancel_queued: true }
      });
      if (sent) this._interrupted = true;
      return sent;
    } catch {
      return false;
    }
  }

  /** Last resort when the control request could not be written; reports whether the signal went out. */
  signal(sig = "SIGINT") {
    if (typeof this.proc?.signal !== "function") return false;
    try {
      this.proc.signal(sig);
      // SIGINT earns the same `result` echo — arm the swallow here too.
      this._interrupted = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Stop ONE background task (not the turn); the CLI's `task_notification` settles the row — fire and forget. */
  stopTask(taskId) {
    if (!taskId) return false;
    try {
      this.rpc.notify("control_request", {
        request_id: `stop-${Date.now()}`,
        request: { subtype: "stop_task", task_id: String(taskId) }
      });
      return true;
    } catch {
      return false;
    }
  }

  /** targetUuid is the turn that GOES; lastSeenUuid is required or the CLI refuses — it cannot tell a rewind from a lagging client. */
  async rewindConversation(targetUuid, lastSeenUuid) {
    try {
      const res = await this.rpc.request("control_request", {
        subtype: "rewind_conversation",
        target_message_uuid: targetUuid,
        last_seen_user_message_uuid: lastSeenUuid || targetUuid,
        interrupt_if_running: true
      }, { timeoutMs: REWIND_CONTROL_TIMEOUT_MS });
      return res || { error: "The CLI answered nothing." };
    } catch (e) {
      return { error: e.message };
    }
  }

  /** Undo writes from `uuid` onward — the same target rewindConversation takes; `dryRun` answers without changing. */
  async rewindFiles(uuid, { dryRun = false } = {}) {
    try {
      const res = await this.rpc.request("control_request", {
        subtype: "rewind_files",
        user_message_id: uuid,
        dry_run: dryRun
      }, { timeoutMs: REWIND_CONTROL_TIMEOUT_MS });
      return res || { error: "The CLI answered nothing." };
    } catch (e) {
      return { error: e.message };
    }
  }

  stop() {
    this.isTurnRunning = false;
    return this.proc.stop();
  }
}
