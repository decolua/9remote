// Adapter for Claude Code CLI using --input-format=stream-json
import { spawn } from "node:child_process";
import readline from "node:readline";

export class ClaudeAdapter {
  constructor({ cwd, onEvent }) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.claude = null;
    this.rl = null;
    this.isTurnRunning = false;
    this.currentMode = "default";
    this.pendingRequests = new Map();
    this.stats = { totalCost: 0, inputTokens: 0, outputTokens: 0 };
    this.metadata = { model: "", sessionId: "", tools: [], skills: [], slashCommands: [] };
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

    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }

    this.claude = spawn("claude", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1" }
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
    if (data.type === "system" && data.subtype === "init") {
      this.metadata = {
        sessionId: data.session_id || "",
        model: data.model || "",
        tools: data.tools || [],
        skills: data.skills || [],
        slashCommands: data.slash_commands || [],
      };
      this.onEvent?.("init", this.metadata);
      return;
    }

    if (data.type === "stream_event") {
      const event = data.event;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        this.onEvent?.("delta", { text: event.delta.text });
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
      if (data.stats) {
        this.stats = { ...this.stats, ...data.stats };
      }

      // If no delta text was streamed yet, use data.result as output (e.g. from /cost, /compact)
      if (typeof data.result === "string" && data.result.trim()) {
        this.onEvent?.("delta", { text: data.result });
      }

      this.onEvent?.("turn_complete", { stats: this.stats, result: data.result });
      return;
    }

    // Assistant message: Tool calls, text fallback, and usage
    if (data.type === "assistant" && data.message) {
      const msg = data.message;
      if (msg.usage) {
        this.stats.inputTokens += msg.usage.input_tokens || 0;
        this.stats.outputTokens += msg.usage.output_tokens || 0;
      }

      const contents = msg.content || [];
      for (const item of contents) {
        if (item.type === "tool_use") {
          this.onEvent?.("tool_start", {
            id: item.id,
            name: item.name,
            input: item.input
          });
        } else if (item.type === "text" && item.text) {
          this.onEvent?.("delta", { text: item.text });
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
            status: isError ? "error" : "done"
          });
        }
      }
    }
  }

  sendPrompt(prompt) {
    if (!this.claude || !this.claude.stdin.writable) {
      this.start(this.currentMode);
    }
    this.isTurnRunning = true;
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
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
