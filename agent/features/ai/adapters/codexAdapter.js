// Adapter for OpenAI Codex CLI using exec --json
import { spawn } from "node:child_process";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";

function getExtendedEnv() {
  const home = os.homedir();
  const extraPaths = process.platform === "win32" ? [
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "Programs"),
    path.join(home, ".cargo", "bin"),
  ] : [
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];
  const envPath = (process.env.PATH || "").split(path.delimiter);
  const combinedPath = Array.from(new Set([...extraPaths, ...envPath])).join(path.delimiter);
  return { ...process.env, PATH: combinedPath, FORCE_COLOR: "1" };
}

export class CodexAdapter {
  constructor({ cwd, onEvent }) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.activeChild = null;
    this.activeThreadId = null;
    this.isTurnRunning = false;
    this.currentModel = "ag/gemini-3.8-flash-high";
    this.reasoningEffort = "medium";
    this.sandboxMode = "workspace-write";
    this.stats = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTurns: 0 };
    this.metadata = { model: this.currentModel, threadId: "", sandbox: this.sandboxMode };
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
    this.onEvent?.("init", { ...this.metadata });
  }

  sendPrompt(prompt) {
    if (this.isTurnRunning) {
      throw new Error("Codex turn is already running.");
    }

    this.isTurnRunning = true;
    const args = ["exec"];

    if (this.activeThreadId) {
      args.push("resume", "--json");
      if (this.currentModel) args.push("-m", this.currentModel);
      if (this.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      args.push(this.activeThreadId, prompt);
    } else {
      args.push("--json");
      if (this.currentModel) args.push("-m", this.currentModel);
      if (this.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      if (this.sandboxMode) args.push("-s", this.sandboxMode);
      args.push(prompt);
    }

    const child = spawn("codex", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: getExtendedEnv()
    });
    this.activeChild = child;

    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        this.handleEvent(event);
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

  handleEvent(event) {
    const type = event.type;
    if (type === "thread.started") {
      this.activeThreadId = event.thread_id;
      this.metadata.threadId = event.thread_id;
      this.onEvent?.("init", { ...this.metadata });
      return;
    }

    if (type === "item.completed") {
      const item = event.item;
      if (item.type === "reasoning") {
        this.onEvent?.("thinking", { text: item.text || "" });
      } else if (item.type === "agent_message") {
        this.onEvent?.("delta", { text: item.text || "" });
      } else if (item.type === "command_execution") {
        this.onEvent?.("tool_result", {
          id: item.id,
          name: "command",
          command: item.command,
          exitCode: item.exit_code,
          output: item.output
        });
      } else if (item.type === "file_change") {
        this.onEvent?.("diff", {
          file: item.path,
          patch: item.patch || item.diff || ""
        });
      }
      return;
    }

    if (type === "turn.completed" && event.usage) {
      this.stats.inputTokens += event.usage.input_tokens || 0;
      this.stats.outputTokens += event.usage.output_tokens || 0;
      this.stats.cachedTokens += event.usage.cached_tokens || 0;
      this.stats.reasoningTokens += event.usage.reasoning_tokens || 0;
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
