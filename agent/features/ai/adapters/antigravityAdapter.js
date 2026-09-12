// Adapter for the Antigravity CLI (`agy`) using --output-format stream-json.
import { getExtendedEnv } from "./env.js";
import { spawn } from "node:child_process";
import readline from "node:readline";

// `agy` has no `--permission-mode` flag: the gate is either on or bypassed. Plan mode
// is the CLI's own read-only mode (`--mode plan`), so that is what it maps to.
const MODE_TO_ARGS = {
  plan: ["--mode", "plan"],
  "accept-edits": ["--dangerously-skip-permissions"]
};

// Widening ladder: a denied action is resolved by the next mode up. Headless cannot
// prompt, so a tool outside these two modes fails outright and the card offers the
// only mode that would have allowed it.
const MODE_LADDER = ["plan", "accept-edits"];
const MODE_LABELS = { plan: "Plan", "accept-edits": "Accept Edits" };

// `agy` reports a denied tool as a plain error string inside tool_info.error.
const DENIED_RE = /(?:user denied permission|permission check failed|auto-denied)/i;

export class AntigravityAdapter {
  constructor({ cwd, onEvent, conversationId = null, model = "" } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.activeChild = null;
    this.activeConversationId = conversationId || null;
    this.isTurnRunning = false;
    // The CLI's model ids already carry their tier (gemini-3.8-flash-low), so a
    // separate effort flag is not sent — the two conflict (verified against 1.2.1).
    this.currentModel = model || "";
    this.permissionMode = "accept-edits";
    // Runtime flags chosen in the Config modal, appended to every turn.
    this.flags = [];
    this.stats = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, totalTurns: 0 };
    // Empty model means "CLI default" — never a label, or it would be sent to the
    // CLI as a real model id and fail the turn. `sessionId` is the key aiSession reads
    // to persist the resumable id (the CLI calls it a conversation, the bus does not).
    this.metadata = {
      model: this.currentModel,
      sessionId: this.activeConversationId || "",
      permissionMode: this.permissionMode
    };
  }

  setOptions({ model, mode, resume, flags }) {
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
    }
    if (mode && MODE_TO_ARGS[mode]) {
      this.permissionMode = mode;
      this.metadata.permissionMode = mode;
    }
    // Resume a past conversation: the next turn runs with `--conversation <id>`.
    if (resume) {
      this.activeConversationId = resume;
      this.metadata.sessionId = resume;
    }
    if (flags && typeof flags === "object") {
      const next = [];
      if (flags.newProject) next.push("--new-project");
      if (flags.sandbox) next.push("--sandbox");
      this.flags = next;
    }
    this.onEvent?.("init", { ...this.metadata });
  }

  // The CLI's own version command. Static so it resolves without spawning a session.
  static doctorSpec() {
    return { command: "agy", args: ["--version"] };
  }

  buildArgs(prompt) {
    const args = ["--output-format", "stream-json"];
    // Dedupe: a user-picked `--output-format` in the Config modal would otherwise
    // ride along as a second copy and the CLI would reject the turn.
    const extra = (this.flags || []).filter((f) => f !== "--output-format");
    if (this.currentModel) args.push("--model", this.currentModel);
    if (this.activeConversationId) args.push("--conversation", this.activeConversationId);
    for (const a of MODE_TO_ARGS[this.permissionMode] || []) args.push(a);
    args.push(...extra);
    // `-p` takes the next argv token as its prompt, so the prompt is attached with `=`
    // — a separate token would be eaten by whichever flag follows it.
    args.push(`-p=${prompt}`);
    return args;
  }

  sendPrompt(prompt) {
    if (this.isTurnRunning) {
      throw new Error("Antigravity turn is already running.");
    }

    this.isTurnRunning = true;
    const child = spawn("agy", this.buildArgs(prompt), {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: getExtendedEnv()
    });
    this.activeChild = child;
    // The turn is non-interactive: an open stdin only risks the CLI waiting on it.
    try { child.stdin?.end(); } catch {}

    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.handleEvent(JSON.parse(line));
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

    child.on("close", () => {
      this.isTurnRunning = false;
      this.activeChild = null;
      this.onEvent?.("turn_complete", { stats: this.stats });
    });
  }

  handleEvent(event) {
    if (event.event === "init") return this.handleInit(event);
    if (event.event === "step_update") return this.handleStep(event.step_update);
    if (event.event === "result") return this.handleResult(event.result);
  }

  handleInit(event) {
    // The CLI may keep the conversation it was started with; only adopt a new id.
    if (event.conversation_id && event.conversation_id !== this.activeConversationId) {
      this.activeConversationId = event.conversation_id;
      this.metadata.sessionId = event.conversation_id;
    }
    // Model and permission mode are echoed here on a resumed or fresh turn, and they
    // are what the composer renders — without this a reload shows defaults.
    if (event.init?.model) this.metadata.model = event.init.model;
    if (event.init?.permission_mode) this.metadata.permissionMode = this.permissionMode;
    this.onEvent?.("init", { ...this.metadata });
  }

  handleStep(step) {
    if (!step || step.step_type === "user_input") return;

    if (step.step_type === "agent_response") {
      // Text arrives as a run of deltas and is forwarded whatever the state: the DONE
      // event is NOT just a trailing newline — the CLI cuts mid-word, so its delta
      // carries the tail of the reply ("…successfu" + "lly executed…"). Dropping it
      // truncates every long answer. Verified: joining every text_delta, ACTIVE and
      // DONE alike, reproduces result.response exactly.
      if (step.text_delta) this.onEvent?.("delta", { text: step.text_delta });
      // Usage rides on the DONE event of each response step, and is a per-step delta
      // (summing every step equals result.usage).
      if (step.state === "DONE" && step.usage) {
        this.addUsage(step.usage);
        this.onEvent?.("stats", { stats: this.stats });
      }
      return;
    }

    if (step.step_type === "tool") return this.handleToolStep(step);
  }

  handleToolStep(step) {
    const info = step.tool_info || {};
    const name = step.tool_name || info.name || "tool";
    const input = info.parameters || {};
    // step_index identifies the tool step: `tool_info` carries no id of its own, and
    // the result must attach to the same id the start announced.
    const id = `${name}-${step.step_index}`;

    if (step.state === "ACTIVE") {
      this.onEvent?.("tool_start", { id, name, input, status: "running" });
      return;
    }

    if (step.state === "DONE") {
      this.onEvent?.("tool_result", { id, name, output: info.output ?? "", status: "done" });
      return;
    }

    if (step.state === "ERROR") {
      const message = info.error?.message || "Tool failed.";
      // Headless cannot raise a permission prompt, so a denied action fails silently.
      // A denied action is a mode problem; anything else is a real tool error.
      if (DENIED_RE.test(message)) {
        const next = MODE_LADDER[MODE_LADDER.indexOf(this.permissionMode) + 1];
        this.onEvent?.("blocked", {
          engine: "antigravity",
          message: `Antigravity blocked this action — ${name} needs a permission the headless CLI cannot request:\n\n${message}`,
          ...(next && { escalate: { mode: next, label: MODE_LABELS[next] } })
        });
        return;
      }
      this.onEvent?.("tool_result", { id, name, error: message, status: "error" });
    }
  }

  handleResult(result) {
    if (!result) return;
    // Usage is counted per step (addUsage below), NOT here: result.usage is cumulative
    // for the whole conversation — adding both double-counts every turn, and a resumed
    // conversation would re-add every token spent before it.
    // One turn is done, whatever it took: `totalTurns` counts turns, not steps, or a
    // turn that called five tools would report six.
    this.stats.totalTurns += 1;
    this.onEvent?.("stats", { stats: this.stats });
    if (result.status && result.status !== "SUCCESS") {
      this.onEvent?.("error", { message: result.error || `Antigravity turn ended with status ${result.status}.` });
    }
  }

  addUsage(usage) {
    this.stats.inputTokens += usage.input_tokens || 0;
    this.stats.outputTokens += usage.output_tokens || 0;
    this.stats.thinkingTokens += usage.thinking_tokens || 0;
    this.stats.cachedTokens += usage.cache_read_tokens || 0;
  }

  stop() {
    this.isTurnRunning = false;
    if (this.activeChild) {
      try { this.activeChild.kill("SIGINT"); } catch {}
      this.activeChild = null;
    }
  }
}
