// test-claude-web/server/claudeProcess.mjs
// Encapsulates Claude CLI process with dual-stream emission (Structured Events + ANSI Terminal)

import { spawn } from "node:child_process";
import readline from "node:readline";

export class ClaudeProcessManager {
  constructor() {
    this.claude = null;
    this.rl = null;
    this.isTurnRunning = false;
    this.currentMode = "default";
    this.currentSessionId = null;
    this.pendingRequests = new Map();
    this.listeners = new Set();
    this.ansiHistory = [];
    this.turnStreamedText = "";
    this.stats = {
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    this.metadata = {
      model: "",
      sessionId: "",
      tools: [],
      skills: [],
      slashCommands: [],
      terminalSlashCommands: [],
      mcpServers: [],
      permissionMode: "default",
      cwd: "",
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, data) {
    for (const listener of this.listeners) {
      try { listener(event, data); } catch {}
    }
  }

  emitAnsi(chunk) {
    this.ansiHistory.push(chunk);
    if (this.ansiHistory.length > 2000) this.ansiHistory.shift();
    this.emit("ansi", { chunk });
  }

  start(mode = this.currentMode, resumeSessionId = null) {
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    if (this.claude) {
      try { this.claude.kill(); } catch {}
    }

    this.currentMode = mode;
    this.isTurnRunning = false;
    this.turnStreamedText = "";
    this.pendingRequests.clear();

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
      this.emitAnsi(`\r\n\x1b[36m[CLAUDE CODE]\x1b[0m Tiếp tục phiên ${resumeSessionId}...\r\n`);
    } else {
      this.emitAnsi(`\r\n\x1b[36m[CLAUDE CODE]\x1b[0m Khởi động phiên mới (mode: ${mode})\r\n`);
    }

    this.claude = spawn("claude", args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.rl = readline.createInterface({ input: this.claude.stdout });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const data = JSON.parse(line);
        this.handleMessage(data);
      } catch {}
    });

    this.claude.on("close", (code) => {
      this.isTurnRunning = false;
      this.emitAnsi(`\r\n\x1b[31m[PROCESS]\x1b[0m Tiến trình Claude đã dừng (code ${code})\r\n`);
      this.emit("close", { code });
    });
  }

  handleMessage(data) {
    // 1. Conversation Reset (from /clear)
    if (data.type === "conversation_reset") {
      this.ansiHistory = [];
      this.emitAnsi(`\r\n\x1b[32m[CLEAR]\x1b[0m Đã làm mới lịch sử hội thoại.\r\n`);
      this.emit("conversation_reset", {});
      return;
    }

    // 2. Compact Boundary (from /compact)
    if (data.type === "compact_boundary") {
      this.emitAnsi(`\r\n\x1b[35m[COMPACT]\x1b[0m Ngữ cảnh cuộc trò chuyện đã được nén thành công.\r\n`);
      this.emit("compact", { trigger: data.trigger || "manual" });
      return;
    }

    // 3. Control Request (Permissions & AskUserQuestion)
    if (data.type === "control_request" && data.request?.subtype === "can_use_tool") {
      const reqId = data.request_id;
      const toolName = data.request.tool_name;
      const toolInput = data.request.input || {};
      const reason = data.request.decision_reason || "Cần quyền xác nhận";

      this.pendingRequests.set(reqId, { toolName, input: toolInput });

      if (toolName === "AskUserQuestion") {
        const questions = toolInput.questions || [];
        this.emitAnsi(`\r\n\x1b[35m[QUESTION]\x1b[0m Claude đang hỏi ý kiến người dùng...\r\n`);
        this.emit("ask_user_question", { requestId: reqId, questions });
        return;
      }

      this.emitAnsi(`\r\n\x1b[33m[PERMISSION]\x1b[0m Yêu cầu quyền: ${toolName}\r\n`);
      this.emit("permission_request", { requestId: reqId, toolName, input: toolInput, reason });
      return;
    }

    // 4. Stream event (real-time text & thinking delta)
    if (data.type === "stream_event") {
      const ev = data.event;
      if (ev?.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && ev.delta?.text) {
          const text = ev.delta.text;
          this.turnStreamedText += text;
          this.emit("delta", { text });
          this.emitAnsi(text.replace(/\n/g, "\r\n"));
        } else if (ev.delta?.type === "thinking_delta" && ev.delta?.thinking) {
          this.emit("thinking", { text: ev.delta.thinking });
        }
      }
    }

    // 5. Init session
    if (data.type === "system" && data.subtype === "init") {
      this.currentSessionId = data.session_id;
      this.metadata = {
        model: data.model || "",
        sessionId: data.session_id,
        tools: data.tools || [],
        skills: data.skills || [],
        slashCommands: data.slash_commands || [],
        terminalSlashCommands: data.terminal_slash_commands || [],
        mcpServers: data.mcp_servers || [],
        permissionMode: data.permissionMode || this.currentMode,
        cwd: data.cwd || "",
      };

      this.emitAnsi(`\x1b[32m[INIT]\x1b[0m Session: ${data.session_id} | Model: ${data.model} (${data.tools?.length || 0} tools, ${data.skills?.length || 0} skills)\r\n`);
      this.emit("init", this.metadata);
    }

    // 6. Prompt suggestions
    if (data.type === "prompt_suggestion" && data.suggestion) {
      this.emit("prompt_suggestion", { suggestion: data.suggestion });
    }

    // 7. Assistant Tool call, text fallback & usage
    if (data.type === "assistant") {
      const msg = data.message || {};
      if (msg.usage) {
        this.stats.inputTokens += msg.usage.input_tokens || 0;
        this.stats.outputTokens += msg.usage.output_tokens || 0;
        this.stats.cacheReadTokens += msg.usage.cache_read_input_tokens || 0;
        this.stats.cacheWriteTokens += msg.usage.cache_creation_input_tokens || 0;
      }

      const contents = msg.content || [];
      for (const item of contents) {
        // Tool call
        if (item.type === "tool_use") {
          this.emitAnsi(`\r\n\x1b[34m[TOOL CALL]\x1b[0m \x1b[1m${item.name}\x1b[0m\r\n`);
          this.emit("tool_call", {
            id: item.id,
            name: item.name,
            input: item.input,
          });
        }

        // Text content (for non-streamed slash command responses like /compact, /help, /cost, etc.)
        if (item.type === "text" && item.text) {
          if (!this.turnStreamedText) {
            this.turnStreamedText = item.text;
            this.emit("delta", { text: item.text });
            this.emitAnsi(item.text.replace(/\n/g, "\r\n") + "\r\n");
          } else if (item.text.length > this.turnStreamedText.length && item.text.startsWith(this.turnStreamedText)) {
            const remaining = item.text.slice(this.turnStreamedText.length);
            this.turnStreamedText = item.text;
            this.emit("delta", { text: remaining });
            this.emitAnsi(remaining.replace(/\n/g, "\r\n"));
          }
        }
      }
    }

    // 8. Tool result
    if (data.type === "user") {
      const contents = data.message?.content || [];
      for (const item of contents) {
        if (item.type === "tool_result") {
          const isError = Boolean(item.is_error);
          const output = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
          this.emitAnsi(`\x1b[${isError ? "31" : "32"}m[TOOL RESULT]\x1b[0m ${isError ? "Thất bại" : "Thành công"}\r\n`);
          this.emit("tool_result", {
            id: item.tool_use_id,
            isError,
            output,
          });
        }
      }
    }

    // 9. Turn completed
    if (data.type === "result") {
      this.isTurnRunning = false;
      const turnCost = Number(data.total_cost_usd) || 0;
      this.stats.totalCost += turnCost;

      // If no text was emitted yet, but result has a message (e.g. from /compact)
      if (!this.turnStreamedText && typeof data.result === "string" && data.result.trim()) {
        this.emit("delta", { text: data.result });
        this.emitAnsi(data.result.replace(/\n/g, "\r\n") + "\r\n");
      }

      this.emitAnsi(`\r\n\x1b[32m✔ [TURN COMPLETE]\x1b[0m $${turnCost.toFixed(4)} (${data.duration_ms || 0}ms)\r\n\r\n`);
      this.emit("done", {
        sessionId: data.session_id,
        cost: turnCost,
        durationMs: data.duration_ms,
        stats: { ...this.stats },
      });
      this.turnStreamedText = "";
    }
  }

  sendPrompt(message) {
    if (!message) return;

    if (!this.claude || this.claude.exitCode !== null) {
      this.start(this.currentMode);
    }

    // Allow /clear to reset state
    if (message === "/clear") {
      this.isTurnRunning = false;
    }

    if (this.isTurnRunning) {
      throw new Error("Lượt chat trước đang chạy. Vui lòng đợi hoặc bấm 'Dừng'.");
    }

    this.isTurnRunning = true;
    this.turnStreamedText = "";
    this.emitAnsi(`\r\n\x1b[34m❯\x1b[0m \x1b[1;37m${message}\x1b[0m\r\n`);

    const payload = {
      type: "user",
      message: { role: "user", content: message },
    };
    this.claude.stdin.write(JSON.stringify(payload) + "\n");
  }

  resolvePermission(requestId, behavior, message = "") {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) throw new Error("Request không tồn tại hoặc đã hết hạn");

    this.pendingRequests.delete(requestId);
    this.emitAnsi(`\x1b[33m[PERMISSION DECISION]\x1b[0m ${behavior.toUpperCase()} cho ${pending.toolName}\r\n`);

    const responsePayload = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: behavior === "allow"
          ? { behavior: "allow", updatedInput: pending.input }
          : { behavior: "deny", message: message || "Từ chối cấp quyền." },
      },
    };
    this.claude.stdin.write(JSON.stringify(responsePayload) + "\n");
  }

  resolveQuestion(requestId, answers) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) throw new Error("Câu hỏi không tồn tại hoặc đã hết hạn");

    this.pendingRequests.delete(requestId);
    this.emitAnsi(`\x1b[35m[QUESTION ANSWERED]\x1b[0m Đã chọn: ${JSON.stringify(answers)}\r\n`);

    const responsePayload = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "allow",
          updatedInput: {
            questions: pending.input.questions || [],
            answers: answers || {},
          },
        },
      },
    };
    this.claude.stdin.write(JSON.stringify(responsePayload) + "\n");
  }

  stop() {
    if (this.claude) {
      this.claude.kill("SIGINT");
      this.emitAnsi(`\r\n\x1b[31m[SIGINT] Đã gửi tín hiệu ngắt lệnh.\x1b[0m\r\n`);
    }
    this.isTurnRunning = false;
  }
}
