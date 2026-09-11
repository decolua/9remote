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

// Codex reports file_change either as {changes:[{path}]} or a bare path/paths field
function firstPath(item) {
  return item?.changes?.[0]?.path || item?.path || item?.paths?.[0] || "";
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

    if (type === "item.started") {
      const item = event.item;
      // Announce the tool now; item.completed later fills in the output for the
      // same id. Without this the result has nothing to attach to and is dropped.
      if (item.type === "command_execution") {
        this.onEvent?.("tool_start", {
          id: item.id,
          name: "command",
          input: { command: item.command },
          status: "running"
        });
      } else if (item.type === "file_change") {
        this.onEvent?.("tool_start", {
          id: item.id,
          name: "file_change",
          input: { file_path: firstPath(item), path: firstPath(item) },
          status: "running"
        });
      } else if (item.type === "mcp_tool_call") {
        this.onEvent?.("tool_start", {
          id: item.id,
          name: item.tool || item.name || "mcp_tool_call",
          input: item.arguments || item.input || {},
          status: "running"
        });
      } else if (item.type === "todo_list") {
        this.onEvent?.("tool_start", {
          id: item.id,
          name: "todo_list",
          input: { todos: item.items || [] },
          status: "running"
        });
      }
      return;
    }

    if (type === "item.completed") {
      const item = event.item;
      if (item.type === "reasoning") {
        this.onEvent?.("thinking", { text: item.text || "" });
      } else if (item.type === "agent_message") {
        this.onEvent?.("delta", { text: item.text || "" });
      } else if (item.type === "command_execution") {
        const output = item.aggregated_output ?? item.output ?? "";
        // Exit code rides along in the output — the card only shows error when set
        if (item.exit_code) {
          this.onEvent?.("tool_result", {
            id: item.id,
            name: "command",
            error: `${output}\n(exit ${item.exit_code})`.trim(),
            status: "error"
          });
        } else {
          this.onEvent?.("tool_result", { id: item.id, name: "command", output, status: "done" });
        }
      } else if (item.type === "file_change") {
        for (const change of item.changes || []) {
          this.onEvent?.("diff", {
            file: change.path,
            patch: change.diff || change.patch || "",
            content: change.kind === "add" ? change.content : ""
          });
        }
        this.onEvent?.("tool_result", { id: item.id, name: "file_change", output: "", status: "done" });
      } else if (item.type === "todo_list") {
        this.onEvent?.("tool_result", { id: item.id, name: "todo_list", output: "", status: "done" });
      } else if (item.type === "mcp_tool_call") {
        this.onEvent?.("tool_result", { id: item.id, name: item.tool || "mcp_tool_call", output: item.result || "", status: "done" });
      } else if (item.type === "web_search") {
        this.onEvent?.("tool_result", { id: item.id, name: "web_search", output: item.query || "", status: "done" });
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
