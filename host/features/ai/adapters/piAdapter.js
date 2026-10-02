// Adapter for the pi coding agent over `pi --mode rpc`. Pi owns the wire omp
// (oh-my-pi) inherited, so everything frame-shaped is OmpAdapter's; only the
// deltas live here: spawn flags, pi's own event names (compaction_*), fork
// spelling of rewind, the editor dialog, and a pulled '/' command list.
// Wire measured from pi 0.87.0 docs/rpc.md.
import { OmpAdapter } from "./ompAdapter.js";

// /session's local answer, shaped like the TUI's: file, id, messages, tokens, cost.
function piSessionStats(s) {
  if (!s) return "No session stats.";
  const t = s.tokens || {};
  const ctx = s.contextUsage ? `\nContext: ${s.contextUsage.tokens}/${s.contextUsage.contextWindow} (${s.contextUsage.percent}%)` : "";
  return `Session ${s.sessionId || "?"}`
    + (s.sessionFile ? `\nFile: ${s.sessionFile}` : "")
    + `\nMessages: ${s.totalMessages ?? "?"} (${s.userMessages ?? "?"} user, ${s.assistantMessages ?? "?"} assistant, ${s.toolResults ?? "?"} tool results)`
    + `\nTokens: ${t.total ?? 0} (in ${t.input ?? 0}, out ${t.output ?? 0}, cache ${(t.cacheRead ?? 0) + (t.cacheWrite ?? 0)})`
    + (s.cost != null ? `\nCost: $${Number(s.cost).toFixed(2)}` : "")
    + ctx;
}

export class PiAdapter extends OmpAdapter {
  // pi has no approval tiers; its enforceable modes are tool allowlists (launch flags).
  _args() {
    const args = ["--mode", "rpc"];
    if (this.permissionMode === "readOnly") args.push("--tools", "read");
    if (this.currentModel) args.push("--model", this.currentModel);
    if (this._resumeId) args.push("--session", this._resumeId);
    return args;
  }

  _modeRestartNotice() {
    return "Pi mode changed — its process restarts to apply.";
  }

  static doctorSpec() {
    return { command: "pi", args: ["--version"] };
  }

  // Same start flow minus omp's subagent subscription (pi core has none); the
  // '/' menu is pulled once instead of riding omp's push event.
  async _ensureStarted() {
    await super._ensureStarted();
    this.rpc?.send("get_commands", {}, { timeoutMs: 10000 })
      .then((data) => {
        const commands = (Array.isArray(data?.commands) ? data.commands : [])
          .map((c) => ({ name: String(c.name || ""), description: String(c.description || "") }))
          .filter((c) => c.name);
        if (commands.length) {
          this.metadata.commands = commands;
          this.onEvent?.("init", { ...this.metadata });
        }
      })
      .catch(() => {});
  }

  _bin() {
    return "pi";
  }

  // pi's local commands the pane forwards as plain text (usage.md): /compact and
  // /name are agent-session RPC here, not prompts — intercept before the LLM sees them.
  sendPrompt(promptText, attachments = null) {
    const text = String(promptText || "").trim();
    if (text === "/compact" || text.startsWith("/compact ")) {
      const customInstructions = text.slice(8).trim();
      this._ensureStarted()
        .then(() => this.rpc.send("compact", customInstructions ? { customInstructions } : {}, { timeoutMs: 600000 }))
        .catch((e) => this._warn(`Compact failed: ${e.message}`));
      return;
    }
    if (text === "/session") {
      this._ensureStarted()
        .then(() => this.rpc.send("get_session_stats", {}, { timeoutMs: 20000 }))
        .then((s) => this.onEvent?.("cli_event", { type: "system", subtype: "local_command", record: { content: piSessionStats(s), level: "info" } }))
        .catch((e) => this._warn(`/session failed: ${e.message}`));
      return;
    }
    if (text === "/clone") {
      this._ensureStarted()
        .then(() => this.rpc.send("clone", {}, { timeoutMs: 20000 }))
        .then(() => this._syncState())
        .then(() => this.onEvent?.("cli_event", { type: "system", subtype: "local_command", record: { content: "Session cloned into a new session file.", level: "info" } }))
        .catch((e) => this._warn(`/clone failed: ${e.message}`));
      return;
    }
    if (text.startsWith("/name ")) {
      const name = text.slice(6).trim();
      if (name) {
        this._ensureStarted()
          .then(() => this.rpc.send("set_session_name", { name }, { timeoutMs: 10000 }))
          .catch(() => {});
      }
      return;
    }
    return super.sendPrompt(promptText, attachments);
  }

  // pi's get_state carries the live model object; surface it so the pane does not
  // read blank until the first pick. Runs before super's init emit.
  async _syncState() {
    try {
      const state = await this.rpc?.send("get_state", {}, { timeoutMs: 10000 });
      const m = state?.model;
      if (m?.id) {
        const full = m.provider ? `${m.provider}/${m.id}` : m.id;
        if (full !== this.metadata.model) {
          this.currentModel = full;
          this.metadata.model = full;
        }
      }
    } catch {}
    super._syncState();
  }

  // Pi names compaction compaction_*; omp says auto_compaction_*.
  _onFrame(frame) {
    if (frame?.type === "agent_end" && frame.willRetry) return; // a retry follows; the turn is not done
    // agent_settled is pi's real "nothing left runs" — the late safety net for a
    // turn whose agent_end the stream lost. No-op when the turn already ended.
    if (frame?.type === "agent_settled") {
      if (!this.isTurnRunning) return;
      this.isTurnRunning = false;
      this.stats.totalTurns += 1;
      this.onEvent?.("turn_complete", { stats: this.stats, result: "", isError: false, subtype: "" });
      return;
    }
    if (frame?.type === "compaction_start") {
      this.onEvent?.("cli_event", { type: "system", subtype: "status", record: { status: "compacting" } });
      return;
    }
    if (frame?.type === "compaction_end") {
      this.onEvent?.("cli_event", { type: "thread/compacted", record: {} });
      return;
    }
    if (frame?.type === "auto_retry_end" && frame.success === false) {
      this._warn(`Retries exhausted: ${frame.finalError || "unknown error"}`);
      return;
    }
    return super._onFrame(frame);
  }

  // pi adds an `editor` dialog — free-text, same as input.
  _onUiRequest(frame) {
    if (frame?.method === "editor") {
      const question = String(frame.title || "Edit");
      this.pendingRequests.set(frame.id, { toolName: "AskUserQuestion", kind: "input", questions: [question] });
      this.isTurnRunning = true;
      this.onEvent?.("permission_request", {
        requestId: frame.id,
        tool: "AskUserQuestion",
        input: { questions: [{ question, header: question.slice(0, 30), isOther: true }] },
        type: "permission"
      });
      return;
    }
    return super._onUiRequest(frame);
  }

  // ── rewind: pi spells omp's branch as fork ────────────────────────────────
  async branchPoints() {
    const data = await this.rpc?.send("get_fork_messages", {}, { timeoutMs: 15000 });
    return (Array.isArray(data?.messages) ? data.messages : [])
      .map((m) => ({ messageId: m.entryId, text: String(m.text || "") }));
  }

  async rewindConversation(entryId) {
    if (!entryId) return { rewound: false, error: "No turn to rewind to." };
    try {
      await this.rpc.send("fork", { entryId }, { timeoutMs: 15000 });
      return { rewound: true };
    } catch (e) {
      return { rewound: false, error: e.message };
    }
  }
}
