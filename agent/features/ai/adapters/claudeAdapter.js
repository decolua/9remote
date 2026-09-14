// Adapter for Claude Code CLI using --input-format=stream-json
//
// The CLI process itself is not owned here. Two carriers implement the same small
// surface — spawn it directly, or ask the daemon to (so the turn outlives an agent
// restart) — and everything below them (the stream-json parser, control requests,
// stats) is one copy, because a second copy is how the two paths drift apart.
import { getExtendedEnv } from "./env.js";
import { stageAttachment } from "../aiAttachment.js";
import { LocalProc } from "../proc/localProc.js";
import { claudeBin } from "../constants.js";

// Images ride as content blocks; other files are staged to disk and named in the
// text. Same shape the terminal path writes, so both read identically to the CLI.
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

// Tools whose whole point is a file change. Their input carries the edit as old/new
// strings rather than a patch, so the diff event is built from them here. Shared with the
// client's row builder, which hides the matching tool row — the two must agree or a file
// shows twice.
export const DIFF_TOOL_NAMES = Object.freeze(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DIFF_TOOLS = new Set(DIFF_TOOL_NAMES);

/** The file an edit tool targets; each tool names it differently. */
const editFilePath = (input = {}) =>
  input.file_path || input.notebook_path || input.path || "";

// Turn an edit tool's input into the `+`/`-` line form the diff card colours and counts.
// Codex already sends a real patch through the same event, so building one keeps the card
// engine-neutral instead of teaching it each CLI's shape. Write returns "" — a whole-file
// add has no old lines, and the card renders `content` as additions on its own.
// Exported for the test that pins the line shape the diff card parses.
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

// What an edit contributes to the diff card, or null when there is nothing to show.
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
    // Tool calls awaiting their result, by tool_use id — see handleMessage.
    this.toolCalls = new Map();
    this.turnStreamedText = "";
    this.stats = { totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 0 };
    this.metadata = { model: "", sessionId: "", tools: [], skills: [], slashCommands: [] };
    // Set when the resume id was refused, so the caller can drop it from its snapshot
    // instead of retrying a conversation the CLI does not have.
    this.resumeRejected = false;
    this._initializedThisSpawn = false;
  }

  /**
   * Spawn the CLI and start parsing it. Returns the lines it emitted before the
   * handlers were in place, for the caller to parse before live output arrives.
   */
  async start(mode = "default", resumeSessionId = null) {
    this._reset(mode);
    // `keepStdin`: this CLI is interactive — it takes every later turn, interrupt and
    // permission answer on the same pipe, so closing it after the handshake would end
    // the conversation at birth (the chat then shows the prompt and nothing back).
    return await this.proc.start({ bin: claudeBin(), args: this._args(mode, resumeSessionId), cwd: this.cwd, env: getExtendedEnv({ hostSessionId: this.hostSessionId }), keepStdin: true });
  }

  /**
   * Re-attach to the process the daemon is already running, asking only for the lines
   * this agent has not parsed. `alive: false` means there is nothing to adopt.
   */
  async adopt(from = 0, epoch = null) {
    this._reset(this.currentMode);
    return await this.proc.attach(from, epoch);
  }

  _reset(mode) {
    this.currentMode = mode;
    this.isTurnRunning = false;
    this.pendingRequests.clear();
    this.toolCalls.clear();
    this.turnStreamedText = "";
    this.resumeRejected = false;
    this._initializedThisSpawn = false;
    // Bind before starting: a line can arrive while start() is still awaiting, and a
    // handler attached afterwards would drop it.
    this.proc.onLine = (line) => this.feed(line);
    this.proc.onExit = (info) => this._handleExit(info);
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

  /**
   * A restart is a respawn with the options this adapter already holds. `resume` is
   * a one-shot action, not a sticky option: keeping it would make every later
   * rebuild re-bind the thread we just left.
   */
  async setOptions({ mode, model, resume, effort }) {
    let fetch = null;
    let restartNeeded = false;
    if (model && model !== this.metadata.model) { this.metadata.model = model; restartNeeded = true; }
    if (mode && mode !== this.currentMode) { this.currentMode = mode; restartNeeded = true; }
    // Reasoning effort is a spawn-time flag, so changing it needs a restart.
    if (effort && effort !== this.effort) { this.effort = effort; restartNeeded = true; }
    if (resume && resume !== this.metadata.sessionId) { this.metadata.sessionId = resume; restartNeeded = true; }
    if (restartNeeded) {
      // stop() must not close the adapter's own line hook: start() rebinds it right
      // after, and a hook cleared in between holds every line the new process writes.
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

  /** Parse one raw line from the CLI. The caller feeds these in line order, so a
   *  re-attach cannot interleave old and new. */
  feed(line) {
    if (!String(line).trim()) return;
    let data;
    try { data = JSON.parse(line); } catch {
      this.onEvent?.("ansi", { chunk: line + "\r\n" });
      return;
    }
    this.handleMessage(data);
  }

  _handleExit({ code, error } = {}) {
    this.isTurnRunning = false;
    // An engine that dies before it ever initialized may have refused the resume id
    // (verified: a bad --resume exits non-zero with "No conversation found"). The CLI
    // emits no init until the first prompt, so a clean pre-init exit proves nothing
    // and must keep the id; only a failure is evidence.
    if (this.metadata.sessionId && !this._initializedThisSpawn && (code || error)) {
      this.resumeRejected = true;
    }
    this.onEvent?.("exit", { code, error });
  }

  handleMessage(data) {
    // A sub-agent's events carry the id of the Agent/Task call that spawned them.
    // Pass it through so the UI nests them under that card instead of showing one
    // flat timeline with no way to tell whose tool call is whose.
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
      // Empty effort means "the CLI's own config decides" — sending it would wipe the
      // level the init published for display, so the chip vanished on the first prompt.
      this.onEvent?.("init", { ...this.metadata, ...(this.effort ? { effort: this.effort } : {}) });
      return;
    }

    if (data.type === "stream_event") {
      const event = data.event;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = event.delta.text || "";
        this.turnStreamedText += text;
        this.onEvent?.("delta", { text });
      } else if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
        this.onEvent?.("thinking", { text: event.delta.thinking });
      } else if (event?.usage?.input_tokens) {
        // Per-step usage: each API step resends the whole conversation, so THIS reading
        // is the window's current fill. result.usage is the sum over every step of the
        // turn (measured 26915 + 27656 = 54571), which overstates the window.
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
      this.isTurnRunning = false;
      if (data.total_cost_usd) {
        this.stats.totalCost += Number(data.total_cost_usd) || 0;
      }
      // The top-level `usage` is THIS turn's own count — the tokens the CLI resent for
      // it, which is the context window's current fill. Verified on 2.1.270: turn 2
      // reported input 26923 while modelUsage (a session-running sum) said 53829.
      if (data.usage) {
        this.stats.inputTokens = data.usage.input_tokens || 0;
        this.stats.outputTokens = data.usage.output_tokens || 0;
        this.stats.cacheReadInputTokens = data.usage.cache_read_input_tokens || 0;
        this.stats.cacheCreationInputTokens = data.usage.cache_creation_input_tokens || 0;
      }
      // modelUsage is the only place the window's size is stated. Summed across models
      // because a turn can span more than one; the widest is the one that can overflow.
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
      this.onEvent?.("turn_complete", { stats: this.stats, result: data.result });
      return;
    }

    // Assistant message: Tool calls and text fallback. Its `usage` is zeroed in
    // stream-json output — the real counts only arrive on `result` (see above).
    if (data.type === "assistant" && data.message) {
      const msg = data.message;
      const contents = msg.content || [];
      for (const item of contents) {
        if (item.type === "tool_use") {
          // Kept until its result arrives: `tool_result` carries only the id, and the
          // diff for an edit needs the name and input the call was made with.
          this.toolCalls.set(item.id, { name: item.name, input: item.input });
          this.onEvent?.("tool_start", {
            id: item.id,
            name: item.name,
            input: item.input,
            parentToolUseId
          });
        } else if (item.type === "text" && item.text) {
          // Fallback only if text was not streamed already
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
      return;
    }

    // User message: Tool execution result from CLI
    if (data.type === "user" && data.message) {
      const contents = data.message.content || [];
      for (const item of contents) {
        if (item.type === "tool_result") {
          const isError = Boolean(item.is_error);
          const output = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
          this.onEvent?.("tool_result", {
            id: item.tool_use_id,
            error: isError ? output : "",
            output: !isError ? output : "",
            status: isError ? "error" : "done",
            parentToolUseId
          });
          // The diff comes from the RESULT, not the call: an edit the user denied never
          // reaches here, so a rejected change cannot paint itself as one that landed.
          // (Codex is gated the same way — it emits on `file_change`.)
          const call = this.toolCalls.get(item.tool_use_id);
          this.toolCalls.delete(item.tool_use_id);
          if (call && !isError && DIFF_TOOLS.has(call.name)) {
            const diff = buildEditDiff(call.name, call.input);
            if (diff) this.onEvent?.("diff", diff);
          }
        }
      }
    }
  }

  sendPrompt(prompt, attachments = null) {
    this.isTurnRunning = true;
    this.turnStreamedText = "";
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: buildContent(prompt, attachments) },
    }) + "\n";
    this.proc.write(payload);
  }

  resolvePermission(requestId, behavior, message = "") {
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);

    this.proc.write(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: behavior === "allow"
          ? { behavior: "allow", updatedInput: pending?.input || {} }
          : { behavior: "deny", message: message || "Permission denied." },
      },
    }) + "\n");
  }

  resolveQuestion(requestId, answers = {}) {
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);

    this.proc.write(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "allow",
          updatedInput: {
            questions: pending?.input?.questions || [],
            answers: answers || {},
          },
        },
      },
    }) + "\n");
  }

  /**
   * Interrupt the TURN, not the process: the CLI keeps its conversation, so the next
   * prompt resumes the same context. Killing it would drop everything queued in it.
   * Returns false when the request could not be written, so the caller can fall back
   * to a signal.
   */
  interrupt() {
    try {
      this.proc.write(JSON.stringify({
        type: "control_request",
        request_id: `int-${Date.now()}`,
        request: { subtype: "interrupt", cancel_queued: true }
      }) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    this.isTurnRunning = false;
    return this.proc.stop();
  }
}
