// test-opencode-web/server/opencodeProcess.mjs
// Encapsulates OpenCode CLI with dual-stream emission (JSON events + ANSI terminal)

import { spawn } from "node:child_process";
import readline from "node:readline";

export class OpenCodeProcessManager {
  constructor() {
    this.activeChild = null;
    this.activeSessionId = null;
    this.isTurnRunning = false;
    this.currentModel = "";
    this.currentVariant = "medium";
    this.listeners = new Set();
    this.ansiHistory = [];
    this.stats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTurns: 0,
    };
    this.metadata = {
      model: this.currentModel || "opencode default",
      sessionId: "",
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

  setOptions({ model, variant }) {
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
    }
    if (variant) {
      this.currentVariant = variant;
    }
    this.emit("init", { ...this.metadata });
  }

  sendPrompt(prompt) {
    if (this.isTurnRunning) {
      throw new Error("Lượt xử lý trước đang chạy. Vui lòng bấm 'Dừng' nếu muốn hủy.");
    }

    this.isTurnRunning = true;
    this.emitAnsi(`\r\n\x1b[35m[OPENCODE ❯]\x1b[0m \x1b[1;37m${prompt}\x1b[0m\r\n`);

    const args = ["run", "--format", "json", "--thinking"];

    if (this.activeSessionId) {
      args.push("-s", this.activeSessionId);
    }
    if (this.currentModel) {
      args.push("-m", this.currentModel);
    }
    if (this.currentVariant) {
      args.push("--variant", this.currentVariant);
    }

    args.push(prompt);

    const child = spawn("opencode", args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
      env: process.env,
    });

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
        this.emitAnsi(line.replace(/\n/g, "\r\n") + "\r\n");
      }
    });

    child.on("close", (code) => {
      this.isTurnRunning = false;
      this.activeChild = null;
      this.emit("done", {
        sessionId: this.activeSessionId,
        exitCode: code,
        stats: { ...this.stats },
      });
    });

    child.on("error", (err) => {
      this.isTurnRunning = false;
      this.activeChild = null;
      this.emitAnsi(`\r\n\x1b[31m[ERROR] ${err.message}\x1b[0m\r\n`);
      this.emit("done", { sessionId: this.activeSessionId, error: err.message, stats: { ...this.stats } });
    });
  }

  handleEvent(data) {
    // 1. Step start (session ID initialized)
    if (data.type === "step_start" && data.sessionID) {
      this.activeSessionId = data.sessionID;
      this.metadata.sessionId = data.sessionID;
      this.emit("init", { ...this.metadata });
    }

    // 2. Text delta
    if (data.type === "text" && data.part?.text) {
      const text = data.part.text;
      this.emit("delta", { text });
      this.emitAnsi(text.replace(/\n/g, "\r\n") + "\r\n");
    }

    // 3. Thinking / Reasoning delta
    if (data.type === "thinking" && data.part?.text) {
      this.emit("thinking", { text: data.part.text });
    }

    // 4. Tool call (bash, edit, read)
    if (data.type === "tool_call" || data.type === "action") {
      const part = data.part || {};
      this.emit("tool_call", {
        id: part.id || `tool_${Date.now()}`,
        name: part.name || part.tool || "Bash",
        input: part.input || part.args || {},
      });
      this.emitAnsi(`\r\n\x1b[33m[TOOL]\x1b[0m ${part.name || part.tool || "tool"}\r\n`);
    }

    // 5. Tool result
    if (data.type === "tool_result") {
      const part = data.part || {};
      this.emit("tool_result", {
        id: part.id || part.tool_call_id,
        isError: Boolean(part.is_error || part.error),
        output: typeof part.output === "string" ? part.output : JSON.stringify(part.output || ""),
      });
    }

    // 6. Step finish (Token stats)
    if (data.type === "step_finish") {
      const tokens = data.part?.tokens || {};
      this.stats.totalTurns += 1;
      this.stats.inputTokens += tokens.input || 0;
      this.stats.outputTokens += tokens.output || 0;

      this.emitAnsi(`\r\n\x1b[32m✔ [STEP FINISH]\x1b[0m tokens in:${tokens.input || 0} out:${tokens.output || 0}\r\n\r\n`);
    }
  }

  resumeSession(sessionId) {
    if (this.isTurnRunning) {
      this.stop();
    }
    this.activeSessionId = sessionId;
    this.metadata.sessionId = sessionId;
    this.emitAnsi(`\r\n\x1b[36m[RESUME]\x1b[0m Tiếp tục phiên OpenCode ${sessionId}...\r\n`);
    this.emit("init", { ...this.metadata });
  }

  reset() {
    if (this.isTurnRunning) {
      this.stop();
    }
    this.activeSessionId = null;
    this.metadata.sessionId = "";
    this.ansiHistory = [];
    this.emitAnsi(`\r\n\x1b[32m[NEW SESSION]\x1b[0m Bắt đầu phiên làm việc OpenCode mới.\r\n`);
    this.emit("conversation_reset", {});
    this.emit("init", { ...this.metadata });
  }

  stop() {
    if (this.activeChild) {
      this.activeChild.kill("SIGINT");
      this.emitAnsi(`\r\n\x1b[31m[SIGINT] Đã dừng tác vụ OpenCode.\x1b[0m\r\n`);
    }
    this.isTurnRunning = false;
    this.activeChild = null;
  }
}
