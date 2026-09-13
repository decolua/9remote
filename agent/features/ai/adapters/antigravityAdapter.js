// Adapter for the Antigravity CLI (`agy`) using --output-format stream-json.
import { getExtendedEnv } from "./env.js";
import { AgentProc } from "../proc/agentProc.js";
import { decodeLine } from "../proc/daemonProc.js";
import { stageAttachment, buildAttachedPrompt } from "../aiAttachment.js";

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

// `agy` names each tool's parameters itself, in PascalCase — CommandLine for
// run_command, AbsolutePath for view_file, TargetFile for write_to_file,
// DirectoryPath/SearchPath for the directory tools (all verified against 1.2.1).
// The cards read one lowercase shape, so unmapped these rows carried no command and
// no path: a Bash row rendered as its bare tool name with nothing to copy.
const PARAM_ALIASES = {
  CommandLine: "command",
  AbsolutePath: "file_path",
  TargetFile: "file_path",
  DirectoryPath: "path",
  SearchDirectory: "path",
  SearchPath: "path",
  Query: "query",
};

function normalizeParameters(parameters) {
  const out = {};
  for (const [key, value] of Object.entries(parameters || {})) {
    out[PARAM_ALIASES[key] || key] = value;
  }
  return out;
}

export class AntigravityAdapter {
  constructor({ cwd, onEvent, proc = null, conversationId = null, model = "", hostSessionId = null } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.hostSessionId = hostSessionId;
    // Turn-per-CLI: a process is born per turn. Under the daemon it outlives an agent
    // restart, and adopt() picks that turn back up.
    this.proc = proc || new AgentProc({ procId: "" });
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

  /**
   * Re-attach to the turn the daemon is still running after an agent restart. A turn
   * that ended while nobody was watching is replayed too — every line it printed is
   * in the daemon's buffer, so the chat shows the answer instead of a blank pane.
   */
  async adopt({ from = 0, epoch = null } = {}) {
    const fetch = await this.proc.attach({ from, epoch });
    if (!fetch.lines?.length && !fetch.alive) return fetch;
    this._bind();
    // The turn's process is the turn: while it lives, the chat is still working.
    this.isTurnRunning = fetch.alive;
    // The gap is healed by the session (it owns the conversation id and the log), so
    // the lines are handed over before the held ones are released.
    this.fetched = fetch;
    return fetch;
  }

  // Handlers bind to the process that owns them, and the same process can carry a
  // second turn later — so this is idempotent, not a one-shot wiring.
  _bind() {
    this.proc.onLine = (line) => this.feed(line);
    this.proc.onExit = ({ code, error }) => {
      this.isTurnRunning = false;
      if (error) this.onEvent?.("error", { message: error });
      else this.onEvent?.("turn_complete", { stats: this.stats, exitCode: code });
    };
  }

  /** Parse one raw line from the CLI. */
  feed(line) {
    if (!String(line).trim()) return;
    try {
      this.handleEvent(JSON.parse(line));
    } catch {
      this.onEvent?.("ansi", { chunk: line + "\r\n" });
    }
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

  sendPrompt(prompt, attachments = null) {
    if (this.isTurnRunning) {
      throw new Error("Antigravity turn is already running.");
    }

    // `agy`'s stream-json input takes text blocks only — an image content block is
    // rejected with 'content block type "image" is not supported'. So every attachment,
    // image included, is handed over as a path in the prompt: verified against the CLI,
    // which reads the file itself and answers about its contents.
    const staged = attachments?.length ? attachments.map(stageAttachment) : null;
    this.isTurnRunning = true;
    this._bind();
    this.proc.start({
      bin: "agy",
      args: this.buildArgs(buildAttachedPrompt(prompt, staged, true)),
      cwd: this.cwd,
      env: getExtendedEnv({ hostSessionId: this.hostSessionId })
    }).then(
      // The turn is non-interactive: an open stdin only risks the CLI waiting on it.
      () => this.proc.closeStdin?.(),
      (err) => {
        this.isTurnRunning = false;
        this.onEvent?.("error", { message: err.message });
      }
    );
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
    // An `invoke_subagent` step. Its own steps never reach this stream — the child
    // runs its own conversation, and the log_uri it hands back points at a transcript
    // this adapter does not read — so the card shows the sub-agent and its brief and
    // leaves the count at zero rather than inventing children.
    if (step.step_type === "subagent") return this.handleSubagentStep(step);
  }

  handleSubagentStep(step) {
    if (step.state === "ACTIVE") {
      const [sub] = step.subagent_info?.subagents || [];
      this.onEvent?.("tool_start", {
        id: `${step.tool_name}-${step.step_index}`,
        name: step.tool_name || "invoke_subagent",
        input: { subagent_type: sub?.role || sub?.type_name, prompt: sub?.initial_prompt },
        status: "running",
      });
      return;
    }
    if (step.state === "ERROR") {
      // Not observed: every recorded agy run that spawned a sub-agent reported DONE,
      // even one told to fail, and a permission denial aborts the run before any step
      // is emitted. Kept because `tool` steps do carry ERROR, and without it a failed
      // sub-agent would be settled as "done" — a success claim this cannot make.
      this.onEvent?.("tool_result", {
        id: `${step.tool_name}-${step.step_index}`,
        name: step.tool_name || "invoke_subagent",
        error: step.subagent_info?.error?.message || "Sub-agent failed.",
        status: "error",
      });
      return;
    }
    if (step.state === "DONE") {
      this.onEvent?.("tool_result", {
        id: `${step.tool_name}-${step.step_index}`,
        name: step.tool_name || "invoke_subagent",
        output: "",
        status: "done",
      });
    }
  }

  handleToolStep(step) {
    const info = step.tool_info || {};
    const name = step.tool_name || info.name || "tool";
    const input = normalizeParameters(info.parameters);
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
    // The daemon asks the CLI first and only kills it if it will not go, so a turn
    // that can flush its transcript still gets to.
    return this.proc.stop();
  }
}
