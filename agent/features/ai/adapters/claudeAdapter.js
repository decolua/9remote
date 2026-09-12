// Adapter for Claude Code CLI using --input-format=stream-json
import { getExtendedEnv } from "./env.js";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { stageAttachment } from "../../terminal/aiAttachment.js";

// Images ride as content blocks; other files are staged to disk and named in the
// text. Same shape the daemon writes, so both paths read identically to the CLI.
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

export class ClaudeAdapter {
  constructor({ cwd, onEvent }) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.claude = null;
    this.rl = null;
    this.isTurnRunning = false;
    this.currentMode = "default";
    // Reasoning effort (--effort); empty means the CLI default.
    this.effort = "";
    this.pendingRequests = new Map();
    this.turnStreamedText = "";
    this.stats = { totalCost: 0, inputTokens: 0, outputTokens: 0 };
    this.metadata = { model: "", sessionId: "", tools: [], skills: [], slashCommands: [] };
  }

  setOptions({ mode, model, resume, effort }) {
    let restartNeeded = false;
    if (model && model !== this.metadata.model) {
      this.metadata.model = model;
      restartNeeded = true;
    }
    if (mode && mode !== this.currentMode) {
      this.currentMode = mode;
      restartNeeded = true;
    }
    // Reasoning effort is a spawn-time flag, so changing it needs a restart.
    if (effort && effort !== this.effort) {
      this.effort = effort;
      restartNeeded = true;
    }
    // Resume a past conversation: restart the CLI bound to that session id.
    if (resume && resume !== this.metadata.sessionId) {
      this.metadata.sessionId = resume;
      restartNeeded = true;
    }
    if (restartNeeded) {
      this.start(this.currentMode, this.metadata.sessionId || null);
    }
    this.onEvent?.("init", { ...this.metadata, permissionMode: this.currentMode, effort: this.effort });
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "claude", args: ["doctor"] };
  }

  start(mode = "default", resumeSessionId = null) {
    this.stop();
    this.currentMode = mode;
    this.isTurnRunning = false;

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

    if (mode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--allow-dangerously-skip-permissions");
    }

    if (this.metadata.model) {
      args.push("--model", this.metadata.model);
    }

    if (this.effort) {
      args.push("--effort", this.effort);
    }

    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }

    this.claude = spawn("claude", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: getExtendedEnv()
    });

    this.rl = readline.createInterface({ input: this.claude.stdout });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const data = JSON.parse(line);
        this.handleMessage(data);
      } catch (err) {
        this.onEvent?.("ansi", { chunk: line + "\r\n" });
      }
    });

    this.claude.stderr?.on("data", (chunk) => {
      this.onEvent?.("ansi", { chunk: chunk.toString() });
    });

    this.claude.on("error", (err) => {
      this.onEvent?.("error", { message: err.message });
      this.isTurnRunning = false;
    });

    this.claude.on("close", (code) => {
      this.isTurnRunning = false;
      this.onEvent?.("exit", { code });
    });
  }

  handleMessage(data) {
    // A sub-agent's events carry the id of the Agent/Task call that spawned them.
    // Pass it through so the UI nests them under that card instead of showing one
    // flat timeline with no way to tell whose tool call is whose.
    const parentToolUseId = data.parent_tool_use_id || "";

    if (data.type === "system" && data.subtype === "init") {
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
      if (data.stats) {
        this.stats = { ...this.stats, ...data.stats };
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
    if (!this.claude || !this.claude.stdin.writable) {
      this.start(this.currentMode);
    }
    this.isTurnRunning = true;
    this.turnStreamedText = "";
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: buildContent(prompt, attachments) },
    }) + "\n";

    this.claude.stdin.write(payload);
  }

  resolvePermission(requestId, behavior, message = "") {
    if (!this.claude || !this.claude.stdin.writable) return;
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);

    const payload = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: behavior === "allow"
          ? { behavior: "allow", updatedInput: pending?.input || {} }
          : { behavior: "deny", message: message || "Permission denied." },
      },
    }) + "\n";
    this.claude.stdin.write(payload);
  }

  resolveQuestion(requestId, answers = {}) {
    if (!this.claude || !this.claude.stdin.writable) return;
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);

    const payload = JSON.stringify({
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
    }) + "\n";
    this.claude.stdin.write(payload);
  }

  stop() {
    this.isTurnRunning = false;
    if (this.claude) {
      try { this.claude.kill("SIGINT"); } catch {}
    }
  }
}
