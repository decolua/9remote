// Adapter for the Antigravity CLI (`agy`) using --output-format stream-json.
import fs from "fs";
import path from "path";
import os from "os";
import { getExtendedEnv } from "./env.js";
import { AgentProc } from "../proc/agentProc.js";
import { createLogger } from "../../../lib/logger.js";
import { stageAttachment, buildAttachedPrompt } from "../aiAttachment.js";
import { recoverFromAntigravityTranscript } from "../transcript.js";

const logger = createLogger("ai");

// agy maps 'plan' to --mode plan and 'accept-edits' to --dangerously-skip-permissions.
const MODE_TO_ARGS = {
  plan: ["--mode", "plan"],
  "accept-edits": ["--dangerously-skip-permissions"]
};

// Widening ladder: headless cannot prompt, so card offers escalation to next mode.
const MODE_LADDER = ["plan", "accept-edits"];
const MODE_LABELS = { plan: "Plan", "accept-edits": "Accept Edits" };

// `agy` reports a denied tool as a plain error string inside tool_info.error.
const DENIED_RE = /(?:user denied permission|permission check failed|auto-denied)/i;

// agy rejects --effort alongside tier suffixes (e.g. -low/-high); strip suffix when effort is set.
const TIER_SUFFIX_RE = /-(?:low|medium|high)$/i;
const EFFORT_LEVELS = ["low", "medium", "high"];

// Headless turns cannot answer agy's interactive question tool — the CLI auto-skips it in
// milliseconds. agy loads ~/.gemini/config/GEMINI.md as a global rule at session start, so
// the guidance rides that file instead of the prompt: nothing in the user's bubble, and the
// conversation title (built from the first message) stays clean.
const HEADLESS_RULE_MARKER = "<!-- 9remote:headless -->";
const HEADLESS_RULE_BLOCK = `${HEADLESS_RULE_MARKER}
When running headless (a session driven by a program such as 9remote), the ask_question tool cannot be answered and auto-skips — ask the user directly in your reply text instead.`;

export function headlessRuleFile() {
  return path.join(os.homedir(), ".gemini", "config", "GEMINI.md");
}

/** Append the headless rule to agy's global rules, idempotently and without touching
 *  anything else in the file. Best effort — an unwritable config must not kill the chat. */
export function ensureHeadlessRule() {
  const file = headlessRuleFile();
  try {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch {}
    if (text.includes(HEADLESS_RULE_MARKER)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, (text ? `${text.replace(/\n*$/, "\n")}\n` : "") + HEADLESS_RULE_BLOCK + "\n");
  } catch (err) {
    logger.warn(`agy headless rule not installed: ${err.message}`);
  }
}
let headlessRuleEnsured = false;

// The same note earlier builds of 9remote prepended to the first prompt, as it reappears
// inside the CLI's transcript — history replay strips it so the user's own bubble never
// shows a line the user never typed.
export const ANTIGRAVITY_HEADLESS_NOTE_RE = /^<system-note>[^\n]*<\/system-note>\n?/;

// Normalize agy's PascalCase tool parameter names to lowercase standard aliases. Shared
// with transcript.js so the live stream and the recovery door agree on one wire shape.
export const ANTIGRAVITY_PARAM_ALIASES = {
  CommandLine: "command",
  AbsolutePath: "file_path",
  TargetFile: "file_path",
  DirectoryPath: "path",
  SearchDirectory: "path",
  SearchPath: "path",
  Query: "query",
  Subagents: "subagents",
  Prompt: "prompt",
  Role: "role",
  Action: "action",
  TaskId: "taskId",
  Message: "message",
  Recipient: "recipient",
  RunPersistent: "runPersistent",
  WaitMsBeforeAsync: "waitMsBeforeAsync",
};

function normalizeParameters(parameters) {
  const out = {};
  for (const [key, value] of Object.entries(parameters || {})) {
    out[ANTIGRAVITY_PARAM_ALIASES[key] || key] = value;
  }
  return out;
}

// Extract diff for edit tools (write_to_file, replace_file_content, multi_replace_file_content, sed_file).
const DIFF_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file"]);

export function antigravityEditDiff(name, input = {}) {
  if (!DIFF_TOOLS.has(name)) return null;
  const file = input.file_path || "";
  if (!file) return null;
  if (name === "write_to_file") {
    if (!input.CodeContent) return null;
    return { file, name, patch: "", content: String(input.CodeContent) };
  }
  if (name === "multi_replace_file_content" && Array.isArray(input.replacements)) {
    const lines = [];
    for (const r of input.replacements) {
      if (r.target) lines.push(...String(r.target).split("\n").map((l) => `-${l}`));
      if (r.replacement) lines.push(...String(r.replacement).split("\n").map((l) => `+${l}`));
    }
    return lines.length ? { file, name, patch: lines.join("\n"), content: "" } : null;
  }
  if (!input.TargetContent && !input.ReplacementContent) return null;
  // A trailing newline would add an empty +/- line that reads as a real change.
  const lines = [];
  const add = (text, sign) => {
    const body = String(text ?? "").replace(/\n$/, "");
    if (body) lines.push(...body.split("\n").map((l) => `${sign}${l}`));
  };
  add(input.TargetContent, "-");
  add(input.ReplacementContent, "+");
  return { file, name, patch: lines.join("\n"), content: "" };
}

// agy's ask_question args → the question card's contract. Real transcripts deliver
// `questions` as an array OR as a JSON-encoded string, with options as bare strings.
export function antigravityQuestions(input = {}) {
  const raw = input.questions;
  if (typeof raw === "string") {
    try { return antigravityQuestions({ questions: JSON.parse(raw) }); }
    catch { return null; }
  }
  if (!Array.isArray(raw)) return null;
  const questions = raw
    .filter((q) => q && String(q.question || "").trim())
    .map((q) => ({
      question: String(q.question),
      options: Array.isArray(q.options)
        ? q.options.map((o) => (typeof o === "string" ? { label: o, description: "" } : o)).filter((o) => o?.label)
        : [],
      multiSelect: Boolean(q.is_multi_select ?? q.multiSelect),
    }));
  return questions.length ? { questions } : null;
}

export class AntigravityAdapter {
  constructor({ cwd, onEvent, proc = null, conversationId = null, model = "", hostSessionId = null } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.hostSessionId = hostSessionId;
    // Turn-per-CLI: a process is born per turn; under daemon adopt() picks it back up.
    this.proc = proc || new AgentProc({ procId: "" });
    this.activeConversationId = conversationId || null;
    this.isTurnRunning = false;
    this._resultFailed = false;
    this._turnHadThinking = false;
    // Per-turn bookkeeping for the transcript door (see _readHiddenTools).
    this._liveToolNames = new Set();
    this._liveDiffFiles = new Set();
    this._doorEmitted = new Set();
    this.currentModel = String(model || "").split("\t")[0].trim();
    this.effort = "";
    this.permissionMode = "accept-edits";
    this.flags = [];
    this.stats = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, totalTurns: 0 };
    // Empty model means CLI default; sessionId persists the resumable conversation id.
    this.metadata = {
      model: this.currentModel,
      sessionId: this.activeConversationId || "",
      permissionMode: this.permissionMode,
      effort: ""
    };
  }

  setOptions({ model, mode, resume, effort, flags }) {
    if (model) {
      const cleanModel = String(model).split("\t")[0].trim();
      this.currentModel = cleanModel;
      this.metadata.model = cleanModel;
      if (TIER_SUFFIX_RE.test(cleanModel)) this.effort = "";
    }
    if (EFFORT_LEVELS.includes(effort)) {
      this.effort = effort;
      this.currentModel = this.currentModel.replace(TIER_SUFFIX_RE, "");
      this.metadata.model = this.currentModel;
    }
    this.metadata.effort = this.effort;
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

  // Re-attach to daemon-buffered turn after agent restart.
  async adopt(from = 0, epoch = null) {
    const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
    const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
    const fetch = await this.proc.attach(f, ep);
    if (!fetch.lines?.length && !fetch.alive) return fetch;
    this._bind();
    // The turn's process is the turn: while it lives, the chat is still working.
    this.isTurnRunning = fetch.alive;
    // The gap is healed by the session (it owns the conversation id and the log), so
    // the lines are handed over before the held ones are released.
    this.fetched = fetch;
    return fetch;
  }

  // Handlers bind to the process that owns them (idempotent per turn).
  _bind() {
    this.proc.onLine = (line) => this.feed(line);
    this.proc.onExit = ({ code, error }) => {
      this._checkTranscriptThinking();
      this.isTurnRunning = false;
      if (error) this.onEvent?.("error", { message: error });
      else {
        this.onEvent?.("turn_complete", { stats: this.stats, exitCode: code, isError: this._resultFailed || code !== 0, subtype: "" });
        this._resultFailed = false;
      }
    };
  }

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
    if (this.currentModel) args.push("--model", this.currentModel.split("\t")[0].trim());
    if (this.effort) args.push("--effort", this.effort);
    if (this.activeConversationId) args.push("--conversation", this.activeConversationId);
    for (const a of MODE_TO_ARGS[this.permissionMode] || []) args.push(a);
    args.push(...extra);
    // Attach prompt with '=' so trailing flags do not consume it.
    args.push(`-p=${prompt}`);
    return args;
  }

  sendPrompt(prompt, attachments = null) {
    if (this.isTurnRunning) {
      throw new Error("Antigravity turn is already running.");
    }
    this._resultFailed = false;
    this._turnHadThinking = false;
    // A persistent run's DONE always lands inside its own turn, so a fresh turn starts clean.
    // Cleared only past the guard — a refused duplicate send must not wipe the running turn's state.
    this._persistentRuns?.clear();
    this._liveToolNames.clear();
    this._liveDiffFiles.clear();
    this._doorEmitted.clear();

    // agy stream-json only accepts text; pass all attachments as file paths in prompt.
    const staged = attachments?.length ? attachments.map(stageAttachment) : null;
    if (!headlessRuleEnsured) {
      ensureHeadlessRule();
      headlessRuleEnsured = true;
    }
    this.isTurnRunning = true;
    this._bind();
    this.proc.start({
      bin: "agy",
      args: this.buildArgs(buildAttachedPrompt(prompt, staged, true)),
      cwd: this.cwd,
      env: getExtendedEnv({ hostSessionId: this.hostSessionId })
    }).then(
      (started) => started?.commit?.((line) => this.feed(line)),
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
    // Forward unhandled CLI events to the pane whole under cli_event.
    this.onEvent?.("cli_event", { type: event.event || event.type || "", subtype: "", record: event });
  }

  handleInit(event) {
    // The CLI may keep the conversation it was started with; only adopt a new id.
    if (event.conversation_id && event.conversation_id !== this.activeConversationId) {
      this.activeConversationId = event.conversation_id;
      this.metadata.sessionId = event.conversation_id;
    }
    if (event.init?.model) this.metadata.model = event.init.model;
    if (event.init?.permission_mode) this.metadata.permissionMode = this.permissionMode;
    this.onEvent?.("init", { ...this.metadata });
  }

  handleStep(step) {
    // Drop user_input echo to prevent duplicate prompt display.
    if (!step || step.step_type === "user_input") return;

    if (step.step_type === "agent_response") {
      const thinking = step.thinking_delta || step.thinkingDelta || step.thinking || step.thought;
      if (thinking) {
        this._turnHadThinking = true;
        this.onEvent?.("thinking", { text: thinking });
      }
      // Forward all text deltas regardless of state (DONE may carry the trailing text).
      if (step.text_delta) this.onEvent?.("delta", { text: step.text_delta });
      // Usage rides on the DONE event of each response step, and is a per-step delta
      // (summing every step equals result.usage).
      if (step.state === "DONE" && step.usage) {
        this.addUsage(step.usage);
        this.onEvent?.("stats", { stats: this.stats });
      }
      return;
    }

    if (step.step_type === "thinking" || step.step_type === "thought") {
      const text = step.thinking_delta || step.thinkingDelta || step.thinking || step.thought || step.text_delta || step.text;
      if (text) {
        this._turnHadThinking = true;
        this.onEvent?.("thinking", { text });
      }
      return;
    }

    if (step.step_type === "tool") return this.handleToolStep(step);
    // Subagent steps run in separate conversation; show subagent card without child steps.
    if (step.step_type === "subagent") return this.handleSubagentStep(step);
    // The live stream black-boxes user-interaction tools (ask_question among them) into
    // empty "unknown" steps — their args and results exist only in the CLI's transcript.
    if (step.step_type === "unknown") return this._readHiddenTools();

    this.onEvent?.("cli_event", { type: "step_update", subtype: step.step_type || "", record: step });
  }

  // The transcript door: recovery reads the CLI's own transcript (current turn only) and
  // this emits the calls the live stream never named. Idempotent — re-running it on every
  // unknown step and at the result heals the race where the file was not flushed yet, and
  // a call whose result lands later settles its already-emitted row.
  _readHiddenTools() {
    if (!this.activeConversationId) return;
    const events = recoverFromAntigravityTranscript(this.cwd, this.activeConversationId);
    if (!events) return;
    for (const { event, data } of events) {
      if (event === "diff") {
        if (!data?.file || this._liveDiffFiles.has(data.file) || this._doorEmitted.has(`d:${data.file}`)) continue;
        this._doorEmitted.add(`d:${data.file}`);
        this.onEvent?.("diff", data);
        continue;
      }
      if (event !== "tool_start" && event !== "tool_result") continue;
      // Distinct keys per side: a call may start on one pass and settle on a later one.
      const key = `${event === "tool_start" ? "s" : "r"}:${data?.id}`;
      if (!data?.id || this._doorEmitted.has(key)) continue;
      // The live stream already drew this call — its row may carry less, but twice is worse.
      if (this._liveToolNames.has(data.name)) continue;
      this._doorEmitted.add(key);
      this.onEvent?.(event, event === "tool_start"
        ? { ...data, input: this.shapeToolInput(data.name, data.input || {}) }
        : data);
    }
  }

  handleSubagentStep(step) {
    if (step.state === "ACTIVE") {
      this._liveToolNames.add(step.tool_name || "invoke_subagent");
      const [sub = {}] = step.subagent_info?.subagents || [];
      // Real transcripts carry PascalCase fields (Role/TypeName/Prompt); accept both.
      this.onEvent?.("tool_start", {
        id: `${step.tool_name}-${step.step_index}`,
        name: step.tool_name || "invoke_subagent",
        input: {
          subagent_type: sub?.Role || sub?.role || sub?.TypeName || sub?.type_name,
          prompt: sub?.Prompt || sub?.prompt || sub?.initial_prompt
        },
        status: "running",
      });
      return;
    }
    if (step.state === "ERROR") {
      // Handle sub-agent ERROR state to avoid settling failed sub-agents as done.
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

  // Card contracts the generic params do not meet: the question card wants
  // {questions:[{question, options:[{label}]}]}, the agent card wants the launching
  // sub-agent's own name and prompt (Subagents entries keep agy's PascalCase).
  shapeToolInput(name, input) {
    if (name === "ask_question") return antigravityQuestions(input) || input;
    if (name === "invoke_subagent" && Array.isArray(input.subagents) && input.subagents.length) {
      const [sub] = input.subagents;
      return {
        ...input,
        subagent_type: sub?.Role || sub?.TypeName || sub?.role || sub?.type_name,
        prompt: sub?.Prompt || sub?.prompt
      };
    }
    return input;
  }

  handleToolStep(step) {
    const info = step.tool_info || {};
    const name = step.tool_name || info.name || "tool";
    this._liveToolNames.add(name);
    const input = normalizeParameters(info.parameters);
    // step_index identifies the tool step: `tool_info` carries no id of its own, and
    // the result must attach to the same id the start announced.
    const id = `${name}-${step.step_index}`;

    if (step.state === "ACTIVE") {
      // Remembered at start: the live stream may strip params off the DONE step, and the
      // persistent flag decides that step's whole result shape.
      if (name === "run_command" && input.runPersistent) (this._persistentRuns ||= new Set()).add(id);
      this.onEvent?.("tool_start", { id, name, input: this.shapeToolInput(name, input), status: "running" });
      return;
    }

    if (step.state === "DONE") {
      // A persistent command detaches at DONE and outlives the turn — claude's async row
      // shape, so it rides the SHELLS strip until the session watchdog settles it.
      const persistent = this._persistentRuns?.delete(id) || (name === "run_command" && Boolean(input.runPersistent));
      this.onEvent?.("tool_result", {
        id,
        name,
        output: info.output ?? "",
        status: persistent ? "running" : "done",
        ...(persistent ? { async: true, handle: id } : null)
      });
      // Only a change that LANDED is a diff; a denied one is the tool row it already is.
      const diff = antigravityEditDiff(name, input);
      if (diff) {
        this._liveDiffFiles.add(diff.file);
        this.onEvent?.("diff", diff);
      }
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
    // Last door pass — the transcript may not have been flushed when the unknown step fired.
    this._readHiddenTools();
    this._checkTranscriptThinking();
    // result.usage is cumulative across turns, so usage is tracked per-step instead.
    this.stats.totalTurns += 1;
    this.onEvent?.("stats", { stats: this.stats });
    // A turn can end SUCCESS with denied tool calls inside — say which, once.
    const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
    if (denied.length) {
      const names = denied.map((d) => d?.display_name || d?.action || "").filter(Boolean).join(", ");
      this.onEvent?.("cli_event", { type: "warning", record: { message: `Antigravity denied: ${names}` } });
    }
    this._resultFailed = Boolean(result.status && result.status !== "SUCCESS");
    if (this._resultFailed) {
      this.onEvent?.("error", { message: result.error || `Antigravity turn ended with status ${result.status}.` });
    }
  }

  // Fallback: agy stream-json may write thinking to transcript without streaming deltas.
  _checkTranscriptThinking() {
    if (this._turnHadThinking || !this.activeConversationId) return;
    try {
      const root = process.env.ANTIGRAVITY_HOME?.trim() || path.join(os.homedir(), ".gemini", "antigravity-cli");
      const logsDir = path.join(root, "brain", this.activeConversationId, ".system_generated", "logs");
      const file = ["transcript_full.jsonl", "transcript.jsonl"]
        .map((name) => path.join(logsDir, name))
        .find((p) => fs.existsSync(p));
      if (!file) return;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(lines[i]);
          if (rec.thinking?.trim()) {
            this._turnHadThinking = true;
            this.onEvent?.("thinking", { text: rec.thinking });
            break;
          }
          if (rec.type === "USER_INPUT") break;
        } catch {}
      }
    } catch {}
  }

  addUsage(usage) {
    this.stats.inputTokens += usage.input_tokens || 0;
    this.stats.outputTokens += usage.output_tokens || 0;
    this.stats.thinkingTokens += usage.thinking_tokens || 0;
    this.stats.cachedTokens += usage.cache_read_tokens || 0;
    // The sum above bills every step; each step resends the growing conversation, so
    // the LAST step's input is what the window currently holds.
    this.stats.contextTokens = usage.input_tokens || 0;
  }

  // Interrupt current turn by stopping process.
  interrupt() {
    logger.info(`[TEMP DIAGNOSTIC] agy interrupt turnRunning=${this.isTurnRunning} conv=${this.activeConversationId || "-"} proc=${this.proc?.constructor?.name || "none"}`);
    if (!this.isTurnRunning) return false;
    this.isTurnRunning = false;
    Promise.resolve(this.proc?.stop())
      .then((r) => logger.info(`[TEMP DIAGNOSTIC] agy proc.stop → ${JSON.stringify(r ?? null).slice(0, 80)}`))
      .catch((e) => logger.warn(`[TEMP DIAGNOSTIC] agy proc.stop refused: ${e.message}`));
    return true;
  }

  signal(sig = "SIGINT") {
    if (typeof this.proc?.signal !== "function") return false;
    try { this.proc.signal(sig); return true; } catch { return false; }
  }

  stop() {
    this.isTurnRunning = false;
    // The daemon asks the CLI first and only kills it if it will not go, so a turn
    // that can flush its transcript still gets to.
    return this.proc.stop();
  }
}
