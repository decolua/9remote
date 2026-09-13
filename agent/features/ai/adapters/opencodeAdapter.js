// Adapter for OpenCode CLI using run --format json --thinking
import { getExtendedEnv } from "./env.js";
import { AgentProc } from "../proc/agentProc.js";
import { decodeLine } from "../proc/daemonProc.js";
import { stageAttachment } from "../aiAttachment.js";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;
const stripAnsi = (text) => String(text || "").replace(ANSI_RE, "");

// `opencode run` rejects an empty message outright ("You must provide a message or a
// command"), and an attachment-only prompt has none — the files ride as --file flags.
// The composer allows a picture with no caption, so the turn needs something to send.
const ATTACHMENT_ONLY_PROMPT = "See the attached file.";

export class OpenCodeAdapter {
  constructor({ cwd, onEvent, proc = null, sessionId = null, model = "", hostSessionId = null } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.hostSessionId = hostSessionId;
    // Turn-per-CLI: a process is born per turn. Under the daemon it outlives an agent
    // restart, and adopt() picks that turn back up.
    this.proc = proc || new AgentProc({ procId: "" });
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
    // Config-modal flags: map the boolean toggles to real argv tokens. The booleans
    // are also kept on metadata, because that is what the modal reads back when it is
    // reopened — without them it would show defaults and revert a previous choice.
    if (flags && typeof flags === "object") {
      const next = [];
      if (flags.pure) next.push("--pure");
      if (flags.printLogs) next.push("--print-logs");
      this.flags = next;
      this.metadata.pure = Boolean(flags.pure);
      this.metadata.printLogs = Boolean(flags.printLogs);
    }
    this.onEvent?.("init", { ...this.metadata });
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "opencode", args: ["debug", "info"] };
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

  /** Parse one raw line from the CLI. stderr rides the same stream — the daemon
   *  relays both — so a permission refusal is recognized here, not by which pipe it
   *  came from. */
  feed(line) {
    if (!String(line).trim()) return;
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      // Non-interactive `run` cannot prompt, so a permission refusal arrives as plain
      // stderr text. Forwarded as `ansi` it was invisible (the chat has no handler for
      // that event), which is why a blocked write looked like nothing happened at all.
      if (/permission requested|auto-rejecting/i.test(line)) {
        // Strip the CLI ANSI colour codes — this text is rendered as markdown, not a terminal
        const clean = stripAnsi(line).trim();
        // A structured `blocked` event drives a card with a mode-escalation button.
        this.onEvent?.("blocked", {
          engine: "opencode",
          message: `OpenCode blocked this action — it needs permission outside the workspace:\n\n${clean}`,
          escalate: { mode: "auto", label: "Auto" }
        });
        return;
      }
      this.onEvent?.("ansi", { chunk: line + "\r\n" });
      return;
    }
    this.handleEvent(data);
  }

  sendPrompt(prompt, attachments = null) {
    if (this.isTurnRunning) {
      throw new Error("OpenCode turn is already running.");
    }

    const staged = attachments?.length ? attachments.map(stageAttachment) : null;
    // Every attachment rides as `--file=`: opencode reads it straight into the model's
    // context, where a path in the text only makes it reach for Read — and that call is
    // auto-rejected for the upload dir, since it sits outside the workspace (verified;
    // an image handed over as a bare path failed the same way). The files are therefore
    // kept out of the text, which carries the caption alone.
    // The flag must come AFTER the positional message and carry its `=`: verified
    // against the CLI, where it before the prompt is parsed as a second message and the
    // space-separated form (`--file <path>`) hangs the run.
    const files = (staged || []).filter((a) => a.path).map((a) => a.path);
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
    args.push(prompt || (files.length ? ATTACHMENT_ONLY_PROMPT : ""));
    for (const file of files) args.push(`--file=${file}`);

    this._bind();
    this.proc.start({
      bin: "opencode",
      args,
      cwd: this.cwd,
      env: getExtendedEnv({ hostSessionId: this.hostSessionId })
    }).then(
      () => this.proc.closeStdin?.(),
      (err) => {
        this.isTurnRunning = false;
        this.onEvent?.("error", { message: err.message });
      }
    );
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
      // A `task` call runs its sub-agent in a separate session (state.metadata.sessionId):
      // those tool calls stream under that id and never reach this one, so the card shows
      // the brief instead of a child count that could only ever read zero.
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
    // The daemon asks the CLI first and only kills it if it will not go, so a turn
    // that can flush its transcript still gets to.
    return this.proc.stop();
  }
}
