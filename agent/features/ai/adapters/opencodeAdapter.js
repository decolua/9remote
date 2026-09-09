// Adapter for OpenCode CLI using run --format json --thinking
import { spawn } from "node:child_process";
import readline from "node:readline";

export class OpenCodeAdapter {
  constructor({ cwd, onEvent }) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.activeChild = null;
    this.activeSessionId = null;
    this.isTurnRunning = false;
    this.currentModel = "";
    this.currentVariant = "medium";
    this.stats = { inputTokens: 0, outputTokens: 0, totalTurns: 0 };
    this.metadata = { model: "opencode default", sessionId: "" };
  }

  setOptions({ model, variant }) {
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
    }
    if (variant) {
      this.currentVariant = variant;
    }
    this.onEvent?.("init", { ...this.metadata });
  }

  sendPrompt(prompt) {
    if (this.isTurnRunning) {
      throw new Error("OpenCode turn is already running.");
    }

    this.isTurnRunning = true;
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
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1" }
    });
    this.activeChild = child;

    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const data = JSON.parse(line);
        this.handleEvent(data);
      } catch (err) {
        this.onEvent?.("ansi", { chunk: line + "\r\n" });
      }
    });

    child.stderr?.on("data", (chunk) => {
      this.onEvent?.("ansi", { chunk: chunk.toString() });
    });

    child.on("error", (err) => {
      this.isTurnRunning = false;
      this.onEvent?.("error", { message: err.message });
    });

    child.on("close", (code) => {
      this.isTurnRunning = false;
      this.activeChild = null;
      this.onEvent?.("turn_complete", { stats: this.stats });
    });
  }

  handleEvent(data) {
    if (data.sessionID && !this.activeSessionId) {
      this.activeSessionId = data.sessionID;
      this.metadata.sessionId = data.sessionID;
      this.onEvent?.("init", { ...this.metadata });
    }

    const type = data.type;
    if (type === "text") {
      this.onEvent?.("delta", { text: data.part?.text || data.text || "" });
    } else if (type === "thinking") {
      this.onEvent?.("thinking", { text: data.part?.text || data.text || "" });
    } else if (type === "tool_call") {
      this.onEvent?.("tool_start", {
        id: data.callID || data.id,
        name: data.tool,
        input: data.input || data.args
      });
    } else if (type === "tool_result") {
      this.onEvent?.("tool_result", {
        id: data.callID || data.id,
        name: data.tool,
        output: data.output || data.result
      });
    } else if (type === "step_finish" && data.tokens) {
      this.stats.inputTokens += data.tokens.input || 0;
      this.stats.outputTokens += data.tokens.output || 0;
      this.stats.totalTurns += 1;
      this.onEvent?.("stats", { stats: this.stats });
    }
  }

  stop() {
    this.isTurnRunning = false;
    if (this.activeChild) {
      try { this.activeChild.kill("SIGINT"); } catch {}
      this.activeChild = null;
    }
  }
}
