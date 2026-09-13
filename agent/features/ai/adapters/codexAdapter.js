// Adapter for OpenAI Codex CLI using exec --json
import { getExtendedEnv } from "./env.js";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { stageAttachment, buildAttachedPrompt } from "../aiAttachment.js";

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
// what a mode means is decided by how much the sandbox allows. These mirror the TUI's
// own presets (Read Only / Default / Full Access).
const MODE_TO_SANDBOX = {
  readOnly: "read-only",
  default: "workspace-write",
  fullAccess: "danger-full-access"
};

// Plan is a separate axis in codex (collaboration_mode), not a sandbox: it keeps the
// gate where it is and makes the model propose instead of execute. Verified: a write
// under this mode is rejected with "writing is blocked by read-only sandbox".
const PLAN_MODE_ARG = ["-c", 'collaboration_mode="plan"'];

// Widening ladder: a blocked action is resolved by the next mode up. Plan sits at the
// bottom — it is the strictest. The step after it is the first *writing* mode, not
// Read Only, which cannot write at all: offering Read Only there would just fail again.
const MODE_LADDER = [["plan", "readOnly"], "default", "fullAccess"];
const MODE_LABELS = { plan: "Plan", readOnly: "Read Only", default: "Default", fullAccess: "Full Access" };

/** The mode that would let a blocked action through, or null when already at the top. */
function nextModeUp(current) {
  for (let i = 0; i < MODE_LADDER.length; i++) {
    const step = MODE_LADDER[i];
    if (Array.isArray(step) ? step.includes(current) : step === current) {
      return MODE_LADDER[i + 1] ?? null;
    }
  }
  return null;
}

export class CodexAdapter {
  constructor({ cwd, onEvent, threadId = null, model = "", hostSessionId = null } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.hostSessionId = hostSessionId;
    this.activeChild = null;
    this.activeThreadId = threadId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.reasoningEffort = "medium";
    this.sandboxMode = "workspace-write";
    // The composer sends `mode`; without this it was dropped and every turn ran at the
    // default policy, so switching modes changed nothing.
    this.permissionMode = "default";
    // Plan mode reasoning is a separate knob in codex (`plan_mode_reasoning_effort`),
    // not a separate model — left empty it falls back to the CLI's own default.
    this.planEffort = "";
    // Codex's own persona for the assistant's tone: friendly | pragmatic | none.
    this.personality = "";
    // Sandbox tuning the TUI exposes but the sandbox policy string does not carry.
    this.networkAccess = false;
    this.addDirs = [];
    this.skipGitRepoCheck = false;
    this.ephemeral = false;
    // Feature flags (`/experimental`, `--enable` / `--disable`).
    this.enable = [];
    this.disable = [];
    this.planMode = false;
    this.stats = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTurns: 0 };
    // Empty model means "CLI default" — never a label. This metadata is echoed back by
    // the session and later fed to `-m`, so a display string here would be sent to the
    // CLI as a real model id and get the provider to 404.
    // The Config modal reads its current values back from this metadata, so every
    // option the modal can set has to be here — otherwise reopening it shows defaults
    // and silently reverts what the user chose.
    this.metadata = { model: this.currentModel, sandbox: this.sandboxMode, permissionMode: this.permissionMode, planMode: false, effort: this.reasoningEffort, planEffort: this.planEffort, personality: this.personality, networkAccess: this.networkAccess, addDirs: this.addDirs, enable: this.enable, disable: this.disable, skipGitRepoCheck: this.skipGitRepoCheck, ephemeral: this.ephemeral };
    this.setThreadId(this.activeThreadId);
  }

  // The thread id is codex's conversation id. The shared init consumer reads that
  // off `sessionId` (every other adapter names it so), so publish it under both:
  // `threadId` for the goal RPC, `sessionId` for the conversation mirror.
  setThreadId(id) {
    this.activeThreadId = id || null;
    this.metadata.threadId = this.metadata.sessionId = id || "";
  }

  setOptions({ model, effort, planEffort, sandbox, mode, resume, personality, networkAccess, addDirs, enable, disable, skipGitRepoCheck, ephemeral }) {
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
    }
    if (effort) {
      this.reasoningEffort = effort;
      this.metadata.effort = effort;
    }
    // Empty string is a real choice here — it means "use the CLI's own default", so
    // these two take any string, unlike the ones where empty means "not sent".
    if (typeof planEffort === "string") {
      this.planEffort = planEffort;
      this.metadata.planEffort = planEffort;
    }
    if (mode && MODE_LABELS[mode]) {
      this.permissionMode = mode;
      this.metadata.permissionMode = mode;
      // Plan is a collaboration mode, not a sandbox — it keeps whatever sandbox the
      // session already had, so the two stay independent axes here.
      this.planMode = mode === "plan";
      this.metadata.planMode = this.planMode;
      const sandbox = MODE_TO_SANDBOX[mode];
      if (sandbox) {
        this.sandboxMode = sandbox;
        this.metadata.sandbox = sandbox;
      }
    }
    if (sandbox) {
      this.sandboxMode = sandbox;
      this.metadata.sandbox = sandbox;
    }
    if (typeof personality === "string") {
      this.personality = personality;
      this.metadata.personality = personality;
    }
    if (typeof networkAccess === "boolean") {
      this.networkAccess = networkAccess;
      this.metadata.networkAccess = networkAccess;
    }
    if (Array.isArray(addDirs)) {
      this.addDirs = addDirs.filter((d) => typeof d === "string" && d);
      this.metadata.addDirs = this.addDirs;
    }
    if (typeof skipGitRepoCheck === "boolean") {
      this.skipGitRepoCheck = skipGitRepoCheck;
      this.metadata.skipGitRepoCheck = skipGitRepoCheck;
    }
    if (typeof ephemeral === "boolean") {
      this.ephemeral = ephemeral;
      this.metadata.ephemeral = ephemeral;
    }
    if (Array.isArray(enable)) {
      this.enable = enable.filter((f) => typeof f === "string" && f);
      this.metadata.enable = this.enable;
    }
    if (Array.isArray(disable)) {
      this.disable = disable.filter((f) => typeof f === "string" && f);
      this.metadata.disable = this.disable;
    }
    // Resume a past thread: the next turn runs `codex exec resume <id>`.
    if (resume) this.setThreadId(resume);
    this.onEvent?.("init", { ...this.metadata });
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "codex", args: ["doctor"] };
  }

  // Options that mean the same argv token on a fresh exec and on a resumed one.
  pushSharedArgs(args, images = []) {
    // `--image=` is a flag, so it rides before the positional prompt in both branches.
    for (const image of images) args.push(`--image=${image}`);
    if (this.personality) args.push("-c", `personality="${this.personality}"`);
    // Network access is a sandbox sub-setting, not part of the policy string.
    if (this.networkAccess) args.push("-c", "sandbox_workspace_write.network_access=true");
    for (const dir of this.addDirs) args.push("--add-dir", dir);
    for (const f of this.enable) args.push("--enable", f);
    for (const f of this.disable) args.push("--disable", f);
    if (this.skipGitRepoCheck) args.push("--skip-git-repo-check");
    if (this.ephemeral) args.push("--ephemeral");
  }

  // The argv for one turn. Split out of sendPrompt so the flags stay testable without
  // spawning a CLI — the two branches (fresh exec vs resume) differ in more than one way.
  buildArgs(prompt, images = []) {
    const args = ["exec"];
    // Full Access means no prompts anywhere. `-s danger-full-access` alone still stops
    // at the approval gate, so the bypass flag has to ride along.
    const bypass = this.permissionMode === "fullAccess";

    if (this.activeThreadId) {
      // `codex exec resume` has no `-s` flag (verified against the CLI: it rejects it
      // with "unexpected argument '-s'"). Sandbox and the other typed flags go through
      // config overrides instead; the boolean ones it does accept ride along directly.
      args.push("resume", "--json");
      if (this.currentModel) args.push("-m", this.currentModel);
      if (this.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      if (this.planMode) args.push(...PLAN_MODE_ARG);
      if (this.planEffort) args.push("-c", `plan_mode_reasoning_effort="${this.planEffort}"`);
      if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
      else if (this.sandboxMode) args.push("-c", `sandbox_mode="${this.sandboxMode}"`);
      this.pushSharedArgs(args, images);
      args.push(this.activeThreadId, prompt);
      return args;
    }

    args.push("--json");
    if (this.currentModel) args.push("-m", this.currentModel);
    if (this.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
    if (this.planMode) args.push(...PLAN_MODE_ARG);
    if (this.planEffort) args.push("-c", `plan_mode_reasoning_effort="${this.planEffort}"`);
    if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
    else if (this.sandboxMode) args.push("-s", this.sandboxMode);
    this.pushSharedArgs(args, images);
    args.push(prompt);
    return args;
  }

  sendPrompt(prompt, attachments = null) {
    if (this.isTurnRunning) {
      throw new Error("Codex turn is already running.");
    }

    const staged = attachments?.length ? attachments.map(stageAttachment) : null;
    // Images ride as files (`--image=`); other files — and the caption — join the text
    // as a path list, which codex reads on its own. Verified against the CLI: `exec` and
    // `exec resume` both take the flag, and an image-only prompt is fine (an empty
    // PROMPT is accepted).
    const images = (staged || []).filter((a) => a.kind === "image").map((a) => a.path);
    this.isTurnRunning = true;
    const args = this.buildArgs(buildAttachedPrompt(prompt, staged), images);

    const child = spawn("codex", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: getExtendedEnv({ hostSessionId: this.hostSessionId })
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
      this.setThreadId(event.thread_id);
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
      } else if (item.type === "collab_tool_call") {
        // Codex's sub-agents. `spawn_agent` starts one; the other calls steer agents
        // that already exist. Only `spawn_agent` carries a brief worth showing.
        this.onEvent?.("tool_start", {
          id: item.id,
          name: item.tool || "collab_tool_call",
          input: item.prompt ? { subagent_type: item.tool, prompt: item.prompt } : {},
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
          const next = nextModeUp(this.permissionMode);
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
      } else if (item.type === "collab_tool_call") {
        // A spawned agent's tool calls run in its own thread and never appear on this
        // stream, so there are no children to nest — the card shows the agent and the
        // brief. `agents_states` is the CLI's own read on how it went: an errored one
        // (no credentials, say) is a failure the summary row would otherwise hide.
        const states = Object.values(item.agents_states || {});
        const errored = states.find((s) => s?.status === "errored");
        const failed = item.status === "failed" || Boolean(errored);
        this.onEvent?.("tool_result", {
          id: item.id,
          name: item.tool || "collab_tool_call",
          ...(failed
            ? { error: errored?.message || `Codex reported ${item.tool} as ${item.status}`, status: "error" }
            : { output: "", status: "done" })
        });
      }
      return;
    }

    if (type === "turn.completed" && event.usage) {
      // codex reports session-running totals here, not this turn's — verified across a
      // resume: the second turn's number already contained the first. Assign them.
      this.stats.inputTokens = event.usage.input_tokens || 0;
      this.stats.outputTokens = event.usage.output_tokens || 0;
      this.stats.cachedTokens = event.usage.cached_input_tokens || 0;
      this.stats.reasoningTokens = event.usage.reasoning_output_tokens || 0;
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
