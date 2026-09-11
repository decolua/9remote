// Adapter for OpenCode CLI using run --format json --thinking
import { getExtendedEnv } from "./env.js";
import { spawn } from "node:child_process";
import readline from "node:readline";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;
const stripAnsi = (text) => String(text || "").replace(ANSI_RE, "");

export class OpenCodeAdapter {
  constructor({ cwd, onEvent, sessionId = null, model = "" } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.activeChild = null;
    this.activeSessionId = sessionId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.currentVariant = "medium";
    // Permission mode from the composer. In non-interactive `run` mode opencode has no
    // way to prompt: it auto-rejects anything outside the workspace and only says so on
    // stderr, so without `--auto` the user sees a silent failure and no permission card.
    this.permissionMode = "default";
    // Runtime flags chosen in the Config modal, appended to every run.
    this.flags = [];
    this.stats = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTurns: 0 };
    // Empty model means "CLI default" — never a label. This metadata is echoed back by
    // the session and later fed to `-m`, so a display string here would be sent to the
    // CLI as a real model id.
    this.metadata = { model: this.currentModel, sessionId: this.activeSessionId || "", permissionMode: this.permissionMode };
  }

  setOptions({ model, variant, mode, resume, flags }) {
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
    }
    if (variant) {
      this.currentVariant = variant;
    }
    // The composer sends `mode`; it used to be dropped here, so switching to Auto had
    // no effect on the CLI at all.
    if (mode) {
      this.permissionMode = mode;
      this.metadata.permissionMode = mode;
    }
    // Resume a past session: the next turn runs `opencode run -s <id>`.
    if (resume) {
      this.activeSessionId = resume;
      this.metadata.sessionId = resume;
    }
    // Config-modal flags: map the boolean toggles to real argv tokens.
    if (flags && typeof flags === "object") {
      const next = [];
      if (flags.pure) next.push("--pure");
      if (flags.printLogs) next.push("--print-logs");
      this.flags = next;
    }
    this.onEvent?.("init", { ...this.metadata });
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "opencode", args: ["debug", "info"] };
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
    // `run` is non-interactive: it cannot raise a permission prompt, so anything outside
    // the workspace is auto-rejected unless we pass this. Auto mode is the user saying
    // "don't ask" — without the flag the request just fails silently.
    if (this.permissionMode === "auto") {
      args.push("--auto");
    }
    args.push(...this.flags);
    args.push(prompt);

    const child = spawn("opencode", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: getExtendedEnv()
    });
    this.activeChild = child;
    try { child.stdin?.end(); } catch {}

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
      const text = chunk.toString();
      // Non-interactive `run` cannot prompt, so a permission refusal arrives only here.
      // Forwarded as `ansi` it was invisible (the chat has no handler for that event),
      // which is why a blocked write looked like nothing happened at all.
      if (/permission requested|auto-rejecting/i.test(text)) {
        // Strip the CLI ANSI colour codes — this text is rendered as markdown, not a terminal
        const clean = stripAnsi(text).trim();
        // A structured `blocked` event drives a card with a mode-escalation button.
        this.onEvent?.("blocked", {
          engine: "opencode",
          message: `OpenCode blocked this action — it needs permission outside the workspace:\n\n${clean}`,
          escalate: { mode: "auto", label: "Auto" }
        });
        return;
      }
      this.onEvent?.("ansi", { chunk: text });
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
    } else if (type === "reasoning" || type === "thinking") {
      this.onEvent?.("thinking", { text: data.part?.text || data.text || "" });
    } else if (type === "tool_use" || type === "tool_call") {
      // Real shape is `{type:"tool_use", part:{tool, callID, state:{status,input,output}}}`.
      // `state.status` moves running → completed, so one branch covers start and result.
      const part = data.part || {};
      const state = part.state || {};
      const id = part.callID || data.callID || part.id || data.id;
      const name = part.tool || data.tool || data.name;
      const input = state.input || data.input || data.args || {};
      // The CLI reports a tool only once it has finished, so announce it first — the
      // client drops a tool_result whose id it has never seen.
      this.onEvent?.("tool_start", { id, name, input });
      if (state.status === "completed" || state.status === "error") {
        const output = state.output ?? data.output ?? data.result ?? "";
        // A failing shell command still reports status "completed" — the exit code is
        // what says it failed, so a non-zero one must surface as an error card.
        const exit = state.metadata?.exit;
        const failed = state.status === "error" || (typeof exit === "number" && exit !== 0);
        this.onEvent?.("tool_result", {
          id,
          name,
          ...(failed
            ? { error: `${output}\n(exit ${exit})`.trim(), status: "error" }
            : { output: String(output), status: "done" })
        });
      }
    } else if (type === "tool_result") {
      this.onEvent?.("tool_result", {
        id: data.callID || data.id,
        name: data.tool,
        output: data.output || data.result
      });
    } else if (type === "step_finish") {
      // Tokens ride on `part.tokens`; the top level carries none, so the old
      // `data.tokens` test never matched and every session reported zero usage.
      const tokens = data.part?.tokens || data.tokens;
      if (tokens) {
        this.stats.inputTokens += tokens.input || 0;
        this.stats.outputTokens += tokens.output || 0;
        this.stats.reasoningTokens = (this.stats.reasoningTokens || 0) + (tokens.reasoning || 0);
        this.stats.totalTurns += 1;
        this.onEvent?.("stats", { stats: this.stats });
      }
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
