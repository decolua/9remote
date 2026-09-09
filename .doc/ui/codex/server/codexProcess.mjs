// test-codex-web/server/codexProcess.mjs
// Encapsulates OpenAI Codex CLI with dual-stream emission (JSONL events + ANSI terminal)

import { spawn } from "node:child_process";
import readline from "node:readline";

export class CodexProcessManager {
  constructor() {
    this.activeChild = null;
    this.activeThreadId = null;
    this.isTurnRunning = false;
    this.currentModel = "ag/gemini-3.8-flash-high";
    this.reasoningEffort = "medium";
    this.sandboxMode = "workspace-write";
    this.listeners = new Set();
    this.ansiHistory = [];
    this.stats = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTurns: 0,
    };
    this.metadata = {
      model: this.currentModel,
      threadId: "",
      sandbox: this.sandboxMode,
      cwd: process.cwd(),
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

  setOptions({ model, effort, sandbox }) {
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
    }
    if (effort) {
      this.reasoningEffort = effort;
    }
    if (sandbox) {
      this.sandboxMode = sandbox;
      this.metadata.sandbox = sandbox;
    }
    this.emit("init", { ...this.metadata });
  }

  sendPrompt(prompt, options = {}) {
    if (this.isTurnRunning) {
      throw new Error("Lượt xử lý trước đang chạy. Vui lòng bấm 'Dừng' nếu muốn hủy.");
    }

    this.isTurnRunning = true;
    this.emitAnsi(`\r\n\x1b[32m[CODEX ❯]\x1b[0m \x1b[1;37m${prompt}\x1b[0m\r\n`);

    const args = ["exec"];

    if (this.activeThreadId) {
      args.push("resume", "--json");
      if (this.currentModel) {
        args.push("-m", this.currentModel);
      }
      if (this.reasoningEffort) {
        args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      }
      args.push(this.activeThreadId, prompt);
    } else {
      args.push("--json");
      if (this.currentModel) {
        args.push("-m", this.currentModel);
      }
      if (this.reasoningEffort) {
        args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      }
      if (this.sandboxMode) {
        args.push("-s", this.sandboxMode);
      }
      args.push(prompt);
    }

    const child = spawn("codex", args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
      env: process.env,
    });

    // Close stdin so Codex exec does not hang waiting for piped stdin
    child.stdin.end();
    this.activeChild = child;

    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const data = JSON.parse(trimmed);
        this.handleEvent(data);
      } catch {
        // Raw text / debug output
        this.emitAnsi(line.replace(/\n/g, "\r\n") + "\r\n");
      }
    });

    child.on("close", (code) => {
      this.isTurnRunning = false;
      this.activeChild = null;
      this.emit("done", {
        threadId: this.activeThreadId,
        exitCode: code,
        stats: { ...this.stats },
      });
    });

    child.on("error", (err) => {
      this.isTurnRunning = false;
      this.activeChild = null;
      this.emitAnsi(`\r\n\x1b[31m[ERROR] ${err.message}\x1b[0m\r\n`);
      this.emit("done", { threadId: this.activeThreadId, error: err.message, stats: { ...this.stats } });
    });
  }

  handleEvent(data) {
    // 1. Thread started
    if (data.type === "thread.started" && data.thread_id) {
      this.activeThreadId = data.thread_id;
      this.metadata.threadId = data.thread_id;
      this.emitAnsi(`\x1b[36m[THREAD]\x1b[0m ID: ${data.thread_id}\r\n`);
      this.emit("init", { ...this.metadata });
    }

    // 2. Item started (commands)
    if (data.type === "item.started") {
      const item = data.item || {};
      if (item.type === "command_execution") {
        this.emitAnsi(`\r\n\x1b[33m[EXEC]\x1b[0m \x1b[1m${item.command}\x1b[0m\r\n`);
        this.emit("tool_call", {
          id: item.id,
          name: "Bash",
          input: { command: item.command },
        });
      }
    }

    // 3. Item completed (reasoning, messages, command results, diffs)
    if (data.type === "item.completed") {
      const item = data.item || {};

      // Thinking / Reasoning
      if (item.type === "reasoning" && item.text) {
        this.emit("thinking", { text: item.text });
      }

      // Assistant text response
      if (item.type === "agent_message" && item.text) {
        this.emit("delta", { text: item.text });
        this.emitAnsi(item.text.replace(/\n/g, "\r\n") + "\r\n");
      }

      // Command execution result
      if (item.type === "command_execution") {
        const isError = item.exit_code !== 0;
        this.emitAnsi(`\x1b[${isError ? "31" : "32"}m[EXIT]\x1b[0m code ${item.exit_code ?? 0}\r\n`);
        this.emit("tool_result", {
          id: item.id,
          isError,
          output: item.aggregated_output || "",
        });
      }

      // File changes / diffs
      if (item.type === "file_change" || item.type === "apply_patch") {
        this.emitAnsi(`\x1b[34m[FILE]\x1b[0m ${item.path || "diff"}\r\n`);
        this.emit("tool_call", {
          id: item.id || `diff_${Date.now()}`,
          name: "Edit",
          input: {
            file_path: item.path || "",
            new_string: item.diff || item.content || "",
          },
        });
      }
    }

    // 4. Turn completed & Token stats
    if (data.type === "turn.completed") {
      const usage = data.usage || {};
      this.stats.totalTurns += 1;
      this.stats.inputTokens += usage.input_tokens || 0;
      this.stats.outputTokens += usage.output_tokens || 0;
      this.stats.cachedTokens += usage.cached_input_tokens || 0;
      this.stats.reasoningTokens += usage.reasoning_output_tokens || 0;

      this.emitAnsi(`\r\n\x1b[32m✔ [TURN COMPLETE]\x1b[0m tokens in:${usage.input_tokens || 0} out:${usage.output_tokens || 0}\r\n\r\n`);
    }
  }

  resumeSession(threadId) {
    if (this.isTurnRunning) {
      this.stop();
    }
    this.activeThreadId = threadId;
    this.metadata.threadId = threadId;
    this.emitAnsi(`\r\n\x1b[36m[RESUME]\x1b[0m Tiếp tục phiên ${threadId}...\r\n`);
    this.emit("init", { ...this.metadata });
  }

  reset() {
    if (this.isTurnRunning) {
      this.stop();
    }
    this.activeThreadId = null;
    this.metadata.threadId = "";
    this.ansiHistory = [];
    this.emitAnsi(`\r\n\x1b[32m[NEW SESSION]\x1b[0m Bắt đầu phiên làm việc Codex mới.\r\n`);
    this.emit("conversation_reset", {});
    this.emit("init", { ...this.metadata });
  }

  stop() {
    if (this.activeChild) {
      this.activeChild.kill("SIGINT");
      this.emitAnsi(`\r\n\x1b[31m[SIGINT] Đã dừng tác vụ Codex.\x1b[0m\r\n`);
    }
    this.isTurnRunning = false;
    this.activeChild = null;
  }
}
