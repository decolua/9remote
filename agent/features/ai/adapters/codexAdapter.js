// Adapter for OpenAI Codex CLI using exec --json
import { getExtendedEnv } from "./env.js";
import { spawn } from "node:child_process";
import readline from "node:readline";

// Codex reports a refusal as plain assistant text ("I can't create X because this
// workspace is read-only"), not a structured event. Matching that text is the only
// signal available; it is deliberately narrow to avoid flagging normal replies.
// Codex reports a refusal as plain assistant text ("I can't create X because this
// workspace is read-only"), not a structured event. Matching that text is the only
// signal available, so the pattern requires a refusal verb next to the reason —
// a bare "read-only" would also match an ordinary sentence describing a file.
const BLOCKED_TEXT_RE = /(?:can(?:not|'t|not)\s+(?:create|write|edit|modify|delete)|unable to\s+(?:create|write|edit|modify)|permission denied|operation not permitted|not permitted to|(?:workspace|sandbox)\s+is\s+read-?only|outside the (?:workspace|sandbox))/i;

// Codex reports file_change either as {changes:[{path}]} or a bare path/paths field
function firstPath(item) {
  return item?.changes?.[0]?.path || item?.path || item?.paths?.[0] || "";
}

// Composer permission mode → codex sandbox policy. The CLI has no single "mode" flag:
// what a mode means is decided by how much the sandbox allows. `suggest` must not write
// at all, `autoEdit` may edit the workspace, `fullAuto` may go anywhere.
const MODE_TO_SANDBOX = {
  suggest: "read-only",
  autoEdit: "workspace-write",
  fullAuto: "danger-full-access"
};

// Widening ladder: a blocked action is resolved by the next mode up.
const MODE_LADDER = ["suggest", "autoEdit", "fullAuto"];
const MODE_LABELS = { suggest: "Suggest", autoEdit: "Auto Edit", fullAuto: "Full Auto" };

export class CodexAdapter {
  constructor({ cwd, onEvent, threadId = null, model = "" } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.activeChild = null;
    this.activeThreadId = threadId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.reasoningEffort = "medium";
    this.sandboxMode = "workspace-write";
    // The composer sends `mode`; without this it was dropped and every turn ran at the
    // default policy, so switching modes changed nothing.
    this.permissionMode = "autoEdit";
    // Runtime flags chosen in the Config modal, appended to every exec.
    this.flags = [];
    this.stats = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTurns: 0 };
    // Empty model means "CLI default" — never a label. This metadata is echoed back by
    // the session and later fed to `-m`, so a display string here would be sent to the
    // CLI as a real model id and get the provider to 404.
    this.metadata = { model: this.currentModel, threadId: this.activeThreadId || "", sandbox: this.sandboxMode, permissionMode: this.permissionMode };
  }

  setOptions({ model, effort, sandbox, mode, resume, flags }) {
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
    }
    if (effort) {
      this.reasoningEffort = effort;
    }
    if (mode && MODE_TO_SANDBOX[mode]) {
      this.permissionMode = mode;
      this.sandboxMode = MODE_TO_SANDBOX[mode];
      this.metadata.permissionMode = mode;
      this.metadata.sandbox = this.sandboxMode;
    }
    if (sandbox) {
      this.sandboxMode = sandbox;
      this.metadata.sandbox = sandbox;
    }
    // Resume a past thread: the next turn runs `codex exec resume <id>`.
    if (resume) {
      this.activeThreadId = resume;
      this.metadata.threadId = resume;
    }
    // Config-modal flags: map the boolean toggles to real argv tokens.
    if (flags && typeof flags === "object") {
      const next = [];
      if (flags.skipGitRepoCheck) next.push("--skip-git-repo-check");
      if (flags.ephemeral) next.push("--ephemeral");
      this.flags = next;
    }
    this.onEvent?.("init", { ...this.metadata });
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "codex", args: ["doctor"] };
  }

  sendPrompt(prompt) {
    if (this.isTurnRunning) {
      throw new Error("Codex turn is already running.");
    }

    this.isTurnRunning = true;
    const args = ["exec"];
    // Full Auto means no prompts anywhere. `-s danger-full-access` alone still stops at
    // the approval gate, so the bypass flag has to ride along.
    const bypass = this.permissionMode === "fullAuto";

    if (this.activeThreadId) {
      // `codex exec resume` has no `-s` flag (verified against the CLI: it rejects it
      // with "unexpected argument '-s'"). The sandbox policy goes through a config
      // override instead. Same for `--skip-git-repo-check` / `--ephemeral`, which
      // resume does accept — those keep riding along in this.flags.
      args.push("resume", "--json");
      if (this.currentModel) args.push("-m", this.currentModel);
      if (this.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
      else if (this.sandboxMode) args.push("-c", `sandbox_mode="${this.sandboxMode}"`);
      args.push(...this.flags);
      args.push(this.activeThreadId, prompt);
    } else {
      args.push("--json");
      if (this.currentModel) args.push("-m", this.currentModel);
      if (this.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
      else if (this.sandboxMode) args.push("-s", this.sandboxMode);
      args.push(...this.flags);
      args.push(prompt);
    }

    const child = spawn("codex", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: getExtendedEnv()
    });
    this.activeChild = child;
    // Close stdin immediately: codex exec blocks waiting for stdin EOF if piped
    try { child.stdin?.end(); } catch {}

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
        // A refusal under a narrow sandbox arrives only as prose. Surface it as a
        // card that offers the mode that would allow the action.
        if (item.text && BLOCKED_TEXT_RE.test(item.text)) {
          const next = MODE_LADDER[MODE_LADDER.indexOf(this.permissionMode) + 1];
          if (next) {
            this.onEvent?.("blocked", {
              engine: "codex",
              message: item.text,
              escalate: { mode: next, label: MODE_LABELS[next] }
            });
          }
        }
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
