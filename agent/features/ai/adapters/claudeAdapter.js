// Adapter for Claude Code CLI using --input-format=stream-json
//
// The CLI process itself is not owned here. Two carriers implement the same small
// surface — spawn it directly, or ask the daemon to (so the turn outlives an agent
// restart) — and everything below them (the stream-json parser, control requests,
// stats) is one copy, because a second copy is how the two paths drift apart.
import { spawn } from "node:child_process";
import { getExtendedEnv } from "./env.js";
import { stageAttachment } from "../aiAttachment.js";
import { toLines } from "../proc/daemonProc.js";
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

/**
 * Runs the CLI as a direct child of this process. Used when no daemon is available —
 * a chat then behaves like any other in-agent engine: it lives only as long as the
 * agent does.
 */
export class LocalProc {
  constructor() {
    this.child = null;
    this.onLine = null;
    this.onExit = null;
    this.tail = "";
  }

  async start({ bin, args = [], cwd, env = {} }) {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env });
    this.child = child;
    // The spawn is asynchronous: a missing binary reports through "error", which
    // without a listener would surface as an unhandled event and take the agent down.
    child.on("error", (err) => this.onExit?.({ code: null, signal: null, error: err.message }));
    this._pump(child.stdout);
    this._pump(child.stderr);
    child.on("close", (code, signal) => {
      if (this.tail) { this.onLine?.(this.tail); this.tail = ""; }
      this.onExit?.({ code, signal: signal || null });
    });
    // Same fetch shape DaemonProc returns: a direct child has no backlog to replay,
    // and nothing can be held because the handlers are already live.
    return { lines: [], after: [], release: () => {} };
  }

  // Nothing to adopt: this process dies with the agent, so there is never a live
  // one to re-attach to.
  async attach() {
    return { alive: false, lines: [], after: [], release: () => {} };
  }

  async lines() {
    return { lines: [], after: [], release: () => {} };
  }

  _pump(stream) {
    if (!stream) return;
    stream.on("data", (chunk) => {
      const { lines, rest } = toLines(this.tail + chunk.toString());
      this.tail = rest;
      for (const line of lines) this.onLine?.(line);
    });
  }

  write(text) { this.child?.stdin?.write(String(text)); }
  signal(sig = "SIGINT") { try { this.child?.kill(sig); } catch {} }
  async stop() { try { this.child?.kill("SIGINT"); } catch {} }
}

export class ClaudeAdapter {
  constructor({ cwd, onEvent, proc = null }) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.proc = proc || new LocalProc();
    this.isTurnRunning = false;
    this.currentMode = "default";
    // Reasoning effort (--effort); empty means the CLI default.
    this.effort = "";
    this.pendingRequests = new Map();
    this.turnStreamedText = "";
    this.stats = { totalCost: 0, inputTokens: 0, outputTokens: 0 };
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
    return await this.proc.start({ bin: claudeBin(), args: this._args(mode, resumeSessionId), cwd: this.cwd, env: getExtendedEnv() });
  }

  /**
   * Re-attach to the process the daemon is already running, asking only for the lines
   * this agent has not parsed. `alive: false` means there is nothing to adopt.
   */
  async adopt(from = 0) {
    this._reset(this.currentMode);
    return await this.proc.attach(from);
  }

  _reset(mode) {
    this.currentMode = mode;
    this.isTurnRunning = false;
    this.pendingRequests.clear();
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
    this.onEvent?.("init", { ...this.metadata, permissionMode: this.currentMode, effort: this.effort });
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
      this.onEvent?.("init", { ...this.metadata, effort: this.effort });
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
      // modelUsage carries the running session totals, already summed by the CLI over
      // every model it used — assign, never add, or each turn re-counts the ones before it.
      if (data.modelUsage) {
        let inputTokens = 0;
        let outputTokens = 0;
        for (const usage of Object.values(data.modelUsage)) {
          inputTokens += usage?.inputTokens || 0;
          outputTokens += usage?.outputTokens || 0;
        }
        this.stats.inputTokens = inputTokens;
        this.stats.outputTokens = outputTokens;
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
    // stream-json output — the real counts only arrive on `result` (see modelUsage above).
    if (data.type === "assistant" && data.message) {
      const msg = data.message;
      const contents = msg.content || [];
      for (const item of contents) {
        if (item.type === "tool_use") {
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
