// One codex chat, over the app-server instead of `exec --json`.
//
// WHY this exists at all — the two transports are not interchangeable:
//
//   exec --json   one process PER TURN, stdout only. Thinking arrives as a single
//                 `item.completed reasoning` AFTER the answer, and a CommandExecution
//                 carries no `parsed_cmd`, so a live read/search row could only be named
//                 by reading the rollout file back off disk.
//   app-server    one process for the whole chat, JSON-RPC both ways. Thinking streams
//                 (`item/reasoning/summaryTextDelta`), and every command arrives with
//                 `commandActions` — the CLI's own read of what the command did.
//
// Shapes here are read off the server's own generated bindings (`codex app-server
// generate-ts`), not guessed.
import { JsonRpcClient } from "./jsonRpcClient.js";
import { sandboxPolicyFor, approvalPolicyFor, collaborationModeFor, turnSettingsFor, BLOCKED_TEXT_RE, MODE_LABELS, nextModeUp } from "../codexSettings.js";
import { elicitationQuestions } from "../elicitation.js";

// `commandActions` type → the name the cards know. Same vocabulary as the rollout
// reader's `parsed_cmd` map, because it is the same information from the same CLI.
const ACTION_NAMES = { read: "read", listFiles: "list_files", search: "search" };

// How long a request that OUGHT to answer quickly may take before it is a dead server.
//
// Measured against the real app-server: initialize 25-56ms, thread/start 73-108ms,
// settings/update ~29ms, experimentalFeature/list ~30ms. This window is ~150x the
// slowest of those — room for a loaded machine, and still fast enough that a chat with
// no server does not sit there looking alive.
//
// Only the requests that OPEN or CHANGE something carry it. `turn/start` does NOT, and
// that is the point of the split: its answer is an ack ("received"), not "finished", so
// a slow ack is normal. Timing one out would flip `isTurnRunning` to false while codex
// kept running the turn, and the next prompt would be refused — a state that diverges
// silently, which is worse than a call that visibly waits.
const REQUEST_TIMEOUT_MS = 15000;

// Notifications the passthrough must NOT carry, because something already did: the ones
// wired above (`item/agentMessage/delta`, the reasoning deltas, token usage) would be
// drawn twice, and the rest are per-CHUNK streams — an output delta arrives once per
// write, so carrying them buries the conversation in the replay window the way Claude's
// telemetry did (807% of one window, measured).
const ALREADY_ROUTED_OR_STREAMING = new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "command/exec/outputDelta",
  "process/outputDelta",
  "fs/changed",
  "thread/tokenUsage/updated"
]);

export class CodexAppServer {
  constructor({ proc, cwd, onEvent, threadId = null, model = "", mode = null, sandbox = null, approvalPolicy = null, effort = null, personality = null, settings = null } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.threadId = threadId || null;
    this.model = model || "";
    this.effort = effort || "";
    this.personality = personality || "";
    this.planMode = false;
    this.planEffort = "";
    // Which preset this chat runs under, so `applyOptions` can re-derive the policy when
    // only part of it changes. Kept as GIVEN, not defaulted here: a caller that named a
    // raw sandbox and no mode must get that sandbox, and defaulting the mode first would
    // shadow it (a chat asking for full access ran as workspace-write until this was
    // found). `sandbox` is the exec transport's spelling of the same three presets.
    this.permissionMode = mode || null;
    this.sandboxName = sandbox || null;
    this.networkAccess = false;
    this.addDirs = [];
    // The options the app set, in the server's vocabulary (see codexSettings.js). Held
    // until the handshake finishes, then sent — a mode picked while the connection is
    // still opening must not be lost, or the turn runs at the old policy.
    this.settings = settings || {
      sandboxPolicy: sandboxPolicyFor({ mode: this.permissionMode, sandbox: this.sandboxName }),
      approvalPolicy: approvalPolicy || approvalPolicyFor({ mode: this.permissionMode })
    };
    this.pendingSettings = {};

    // The unregistered half of the protocol comes here instead of nowhere: the server
    // declares 83 notifications and this class wires 7, so a record nobody routed used to
    // disappear without a log or an error. The pane re-renders the CLI's own TUI, so it
    // still has to REACH it, whole and under the server's own name — see the fallthrough
    // in _wire's caller. `_itemEvents` covers the item vocabulary the same way.
    this.rpc = new JsonRpcClient(proc, {
      onMessage: (msg) => {
        if (ALREADY_ROUTED_OR_STREAMING.has(msg.method)) return;
        // Same rule the wired handlers follow: a notification for another chat is not
        // this one's. Most carry `threadId`; the ones that do not (`skills/changed`,
        // `account/updated`) are process-wide and belong to every chat equally.
        if (!this._mine(msg.params)) return;
        this.onEvent?.("cli_event", { type: msg.method || "", subtype: "", record: msg.params || {} });
      }
    });
    this.isTurnRunning = false;
    this.closed = false;
    // The open gates, keyed by the id an answer must carry. The session reads this to
    // restore a permission card after a replay, so it holds the card's own shape.
    this.gates = new Map();
    // Plan text as it streams, per item, so a delta can restate the whole plan so far —
    // the card renders `input.plan`, and a fragment of it is not a plan.
    this.planText = new Map();
    this._wire();
  }

  _wire() {
    const rpc = this.rpc;

    rpc.on("item/reasoning/summaryTextDelta", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = true;
      this.onEvent?.("thinking", { text: p.delta || "" });
    });
    // The same thought in its other spelling: a model that reports raw reasoning rather
    // than a summary. Both reach the pane the same way.
    rpc.on("item/reasoning/textDelta", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = true;
      this.onEvent?.("thinking", { text: p.delta || "" });
    });

    rpc.on("item/agentMessage/delta", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = true;
      this.onEvent?.("delta", { text: p.delta || "" });
    });

    // A plan being WRITTEN, one piece at a time. The server's own note says to treat these
    // as a preview — the completed item is the authority — which is exactly how the card
    // uses them: the text grows here and is replaced by the whole thing when the item
    // completes. Without this a plan appeared only once it was already finished.
    rpc.on("item/plan/delta", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = true;
      this.planText.set(p.itemId, (this.planText.get(p.itemId) || "") + (p.delta || ""));
      this.onEvent?.("tool_start", {
        id: p.itemId, name: "update_plan", status: "running",
        input: { plan: this.planText.get(p.itemId) }
      });
    });

    rpc.on("item/started", (p) => {
      if (!this._mine(p)) return;
      const item = p.item || {};
      // The completed record restates the whole summary; it was already streamed.
      if (item.type === "reasoning") return;
      this.isTurnRunning = true;
      for (const ev of this._itemEvents(item, "inProgress")) this._emit(ev);
    });

    rpc.on("item/completed", (p) => {
      if (!this._mine(p)) return;
      const item = p.item || {};
      if (item.type === "reasoning") return;
      // A refusal under a narrow sandbox arrives as PROSE — codex has no structured
      // refusal event on either transport. Surface it as the card that offers the mode
      // which would allow the action, the same one the exec transport draws. Without
      // this the default transport showed the sentence and no way out of it.
      if (item.type === "agentMessage" && item.text && BLOCKED_TEXT_RE.test(item.text)) {
        const next = nextModeUp(this.permissionMode);
        if (next) {
          this.onEvent?.("blocked", {
            engine: "codex",
            message: item.text,
            escalate: { mode: next, label: MODE_LABELS[next] }
          });
        }
      }
      // The ENVELOPE is the status for every item that has none of its own: the server
      // declares items without a `status` field (`webSearch`, `plan`, `imageView`,
      // `contextCompaction`), and reading only the item left each of them announced and
      // never completed — a row that spun forever, and for the passthrough no record at
      // all. `item.status` still wins where the item states one (`failed`, `declined`).
      for (const ev of this._itemEvents(item, item.status || "completed")) this._emit(ev);
    });

    rpc.on("thread/tokenUsage/updated", (p) => {
      const last = p.tokenUsage?.last || {};
      this.onEvent?.("stats", {
        inputTokens: last.inputTokens || 0,
        outputTokens: last.outputTokens || 0,
        cachedTokens: last.cachedInputTokens || 0,
        reasoningTokens: last.reasoningOutputTokens || 0
      });
    });

    rpc.on("turn/completed", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = false;
      // Gates belong to the turn that asked them, and this one is over. A request left
      // here was abandoned — an interrupt, or the turn failing around it — and it comes
      // back from a replay as a question card whose answer reaches no server handler.
      this.gates.clear();
      const turn = p.turn || {};
      if (turn.status === "failed") {
        this.onEvent?.("error", { message: turn.error?.message || "Codex reported the turn as failed" });
      }
      this.onEvent?.("turn_complete", { stats: {} });
    });

    // The turn's plan, restated whole every time it moves — which is exactly the task
    // list the pane's strip renders, in the CLI's own vocabulary (`pending` /
    // `inProgress` / `completed`, `step`). This transport had NO todo item at all: the
    // exec stream's `todo_list` does not exist here, and `turn/plan/updated` was reaching
    // the pane as a raw record nothing drew. So the strip stayed empty for a whole plan.
    rpc.on("turn/plan/updated", (p) => {
      if (!this._mine(p)) return;
      const todos = (p.plan || []).map((s) => ({ content: s.step || "", status: s.status || "pending" }));
      if (!todos.length) return;
      this.onEvent?.("tool_start", {
        id: `plan-${p.turnId || "turn"}`,
        name: "todo_list",
        status: "running",
        input: { todos, ...(p.explanation ? { explanation: p.explanation } : null) }
      });
    });

    // The gates. Registered so the client routes them here rather than refusing them —
    // but the handler answers NOTHING: the CLI stays blocked until the user decides, and
    // an auto-answer would be the app approving on their behalf. The id is the JSON-RPC
    // one, which is what the answer has to go back on; `callId` is codex's own handle for
    // the call and means nothing on the wire.
    rpc.on("execCommandApproval", (p, id) => this._askPermission(p, id, "exec"));
    rpc.on("applyPatchApproval", (p, id) => this._askPermission(p, id, "patch"));
    rpc.on("item/commandExecution/requestApproval", (p, id) => this._askPermission(p, id, "exec"));
    rpc.on("item/fileChange/requestApproval", (p, id) => this._askPermission(p, id, "patch"));
    rpc.on("item/tool/requestUserInput", (p, id) => this._askQuestion(p, id));
    // Asking for MORE than the thread was opened with — network, or a path outside the
    // sandbox. Unregistered, this one was auto-refused by the client's own refusal path
    // with nobody told: the CLI asked, the app said no on the user's behalf, and the turn
    // carried on without the access it needed. It is a gate like any other, so it gets a
    // card and waits.
    rpc.on("item/permissions/requestApproval", (p, id) => this._askPermissionGrant(p, id));
    // An MCP server asking the user something (`elicitation/create` in the MCP spec). It is
    // a question like any other — the schema's properties ARE the questions — and it goes
    // through the same card. Unregistered, the client refused it on the user's behalf, so
    // an MCP tool that needed an answer got a denial nobody asked for.
    rpc.on("mcpServer/elicitation/request", (p, id) => this._askElicitation(p, id));

    rpc.onExit((info) => this._handleExit(info));
  }

  /** Notifications for another chat must not leak into this one. */
  _mine(params) {
    return !this.threadId || !params?.threadId || params.threadId === this.threadId;
  }

  _emit(ev) { this.onEvent?.(ev.event, ev.data); }

  _askPermission(params, rpcId, kind) {
    const command = (Array.isArray(params.command) ? params.command : [params.command]).filter((c) => typeof c === "string").join(" ");
    this.isTurnRunning = true;
    const tool = kind === "patch" ? "apply_patch" : "command";
    const input = { ...params, command, path: params.path || "" };
    this.gates.set(String(rpcId), { requestId: String(rpcId), toolName: tool, input });
    this.onEvent?.("permission_request", { requestId: String(rpcId), tool, input, type: "permission" });
  }

  _askQuestion(params, rpcId) {
    this.isTurnRunning = true;
    const questions = params.questions || [];
    this.gates.set(String(rpcId), { requestId: String(rpcId), toolName: "request_user_input", input: { questions } });
    // The pane's question card is reached through `permission_request`, the same door every
    // other gate takes — emitted as its own event name it reached no listener at all, so a
    // question the CLI was blocking on never appeared. `AskUserQuestion` is the tool name
    // that door switches on (see AiPaneView), and the questions ride in `input` where the
    // card reads them; this CLI's fields are the ones that card already wants
    // (`question`, `options[].label`).
    this.onEvent?.("permission_request", {
      requestId: String(rpcId), tool: "AskUserQuestion", input: { questions }, type: "question"
    });
  }

  /**
   * Answer a `request_user_input` gate.
   *
   * The reply is the server's own `ToolRequestUserInputResponse`: `{answers: {<question
   * id>: {answers: [<text>]}}}` — keyed by the question's ID, each answer a LIST. The card
   * hands back the labels keyed by the question's TEXT (that is what every engine's card
   * does), so the ids are looked up here. An answer for a question nobody asked is
   * dropped rather than sent: the server validates the keys and refuses the whole reply.
   */
  resolveQuestion(requestId, answers = {}) {
    if (!requestId) return false;
    const gate = this.gates.get(String(requestId));
    if (!this.gates.delete(String(requestId))) return false;
    const byText = new Map((gate?.input?.questions || []).map((q) => [q.question, q.id]));
    const out = {};
    for (const [key, value] of Object.entries(answers || {})) {
      const id = byText.get(key) || key;
      if (!byText.size || [...byText.values()].includes(id)) out[id] = { answers: [String(value)] };
    }
    // An elicitation is ALSO a question, but its reply is the MCP one: a decision word and
    // a `content` object keyed by the schema's property names. Same card, different answer.
    if (gate?.input?.kind === "elicitation") this.rpc.respond(requestId, {
      action: "accept",
      content: Object.fromEntries(Object.entries(out).map(([id, a]) => [id, a.answers[0]])),
      _meta: null
    });
    else this.rpc.respond(requestId, { answers: out });
    return true;
  }

  /**
   * An MCP server's `elicitation/create`: it states its ask as a JSON Schema, which
   * `elicitationQuestions` turns into the question shape the card renders. The reply is
   * MCP's own (`{action, content}`), not this server's — see `resolveQuestion`.
   */
  _askElicitation(params, rpcId) {
    this.isTurnRunning = true;
    const questions = elicitationQuestions(params);
    const input = {
      kind: "elicitation",
      questions,
      message: params.message || "",
      serverName: params.serverName || ""
    };
    this.gates.set(String(rpcId), { requestId: String(rpcId), toolName: "AskUserQuestion", input });
    this.onEvent?.("permission_request", {
      requestId: String(rpcId), tool: "AskUserQuestion", input, type: "question"
    });
  }

  /**
   * More access than the thread opened with: `permissions` is the profile being asked for
   * (`network`, `fileSystem`), and `reason` is the CLI's own sentence about why. It is a
   * permission gate — the same card, the same Allow/Deny — so it lands in the same map and
   * answers through `resolvePermission`. The difference is only the REPLY's shape: this one
   * states what was granted, not a bare decision (see `resolvePermission`).
   */
  _askPermissionGrant(params, rpcId) {
    this.isTurnRunning = true;
    const input = {
      kind: "permission_grant",
      reason: params.reason || "",
      permissions: params.permissions || {},
      cwd: params.cwd || this.cwd
    };
    this.gates.set(String(rpcId), { requestId: String(rpcId), toolName: "request_permissions", input });
    this.onEvent?.("permission_request", { requestId: String(rpcId), tool: "request_permissions", input, type: "permission" });
  }

  /**
   * A turn item → the wire events it stands for.
   *
   * A command is named from the CLI's own `commandActions` — the parse it already did —
   * so the row says "read … a.txt" without a rollout read. `commandActions[].command` is
   * also the command WITHOUT its login-shell wrapper (`/bin/bash -lc`, `powershell
   * -Command`, `cmd /d /s /c`), which is the same line the replay door shows.
   */
  _itemEvents(item, status) {
    const id = item.id;
    // `interrupted` belongs here and is a status of its own in the server's bindings
    // (`CollabAgentToolCallStatus` is the one that has it). Left out, an agent the user
    // interrupted stayed announced and never completed — a row that spun forever.
    const done = status === "completed" || status === "failed" || status === "declined" || status === "interrupted";
    const out = [];

    if (item.type === "commandExecution") {
      const actions = (item.commandActions || []).filter((a) => a?.command);
      const name = ACTION_NAMES[actions[0]?.type] || "command";
      const command = actions.length ? actions.map((a) => a.command).join("; ") : (item.command || "");
      const first = actions[0] || {};
      out.push({
        event: "tool_start",
        data: {
          id, name, status: done ? "done" : "running",
          input: { command, ...(first.path ? { path: first.path, file_path: first.path } : {}), ...(first.query ? { query: first.query } : {}) }
        }
      });
      if (!done) return out;
      const output = item.aggregatedOutput ?? "";
      const failed = status === "failed" || status === "declined" || (item.exitCode ?? 0) !== 0;
      const reason = status === "declined" ? "Command declined" : `${output}\n(exit ${item.exitCode})`.trim();
      out.push({
        event: "tool_result",
        data: { id, name, output: failed ? "" : output, error: failed ? reason : "", status: failed ? "error" : "done" }
      });
      return out;
    }

    if (item.type === "fileChange") {
      for (const change of item.changes || []) {
        out.push({ event: "diff", data: { file: change.path || "", patch: change.diff || "", content: "" } });
      }
      out.push({
        event: "tool_result",
        data: { id, name: "file_change", output: "", error: status === "failed" ? "Patch failed to apply" : "", status: status === "failed" ? "error" : "done" }
      });
      return out;
    }

    if (item.type === "mcpToolCall") {
      out.push({ event: "tool_start", data: { id, name: item.tool || "mcp_tool_call", status: done ? "done" : "running", input: item.arguments || {} } });
      if (done) out.push({ event: "tool_result", data: { id, name: item.tool || "mcp_tool_call", output: typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? ""), error: "", status: "done" } });
      return out;
    }

    if (item.type === "webSearch") {
      out.push({ event: "tool_start", data: { id, name: "web_search", status: done ? "done" : "running", input: { query: item.query || "" } } });
      if (done) out.push({ event: "tool_result", data: { id, name: "web_search", output: item.query || "", error: "", status: "done" } });
      return out;
    }

    if (item.type === "plan") {
      // The item is the authority on the text, so a streamed preview is replaced by it
      // rather than appended to (the server says the two need not even match).
      const text = item.text || this.planText.get(id) || "";
      if (done) this.planText.delete(id);
      out.push({ event: "tool_start", data: { id, name: "update_plan", status: done ? "done" : "running", input: { plan: text } } });
      if (done) out.push({ event: "tool_result", data: { id, name: "update_plan", output: "", error: "", status: "done" } });
      return out;
    }

    // An image the agent looked at — a screenshot it took, or a file it read. It is a
    // READ, so it draws as the file card with the path, which is what the TUI shows.
    // Measured in the rollouts on this machine: 3 of these, drawn by nothing before.
    if (item.type === "imageView") {
      out.push({
        event: "tool_start",
        data: { id, name: "view_image", status: done ? "done" : "running", input: { path: item.path || "", file_path: item.path || "" } }
      });
      if (done) out.push({ event: "tool_result", data: { id, name: "view_image", output: "", error: "", status: "done" } });
      return out;
    }

    // Entering and leaving code review are two items the CLI declares, and the pair is one
    // happening: a review with the text it was asked to perform. Named as the review's own
    // tool, so it draws the review's own card — mapping these onto Claude's plan-mode pair
    // made the pane say "Plan Mode Activated", about the wrong engine, for a review.
    if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
      out.push({
        event: "tool_start",
        data: { id, name: item.type, status: "done", input: { review: item.review || "" } }
      });
      out.push({
        event: "tool_result",
        data: { id, name: item.type, output: "", error: "", status: "done" }
      });
      return out;
    }

    if (item.type === "collabAgentToolCall") {
      // The sub-agent, as the item the CLI declares: `prompt` is the brief and
      // `agentsStates` its own read on how it went — an errored one carries `message`
      // while a healthy one is a bare status. Names come out in the snake_case the
      // engine registry maps (`spawnAgent` → `spawn_agent`), which is also how the exec
      // transport spells the same call, so both doors draw one card.
      const name = item.tool ? item.tool.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : "agent";
      out.push({
        event: "tool_start",
        data: { id, name, status: done ? "done" : "running", input: item.prompt ? { subagent_type: item.tool, prompt: item.prompt } : {} }
      });
      if (!done) return out;
      const errored = Object.values(item.agentsStates || {}).find((s) => (s?.status || s) === "errored");
      // `agentsStates` is the CLI's own read on the agent, and it is the more specific
      // answer when the two disagree: recorded on a real run, an agent with no credentials
      // reads `completed` on the item while its state says `errored`.
      const failed = status === "failed" || status === "interrupted" || Boolean(errored);
      out.push({
        event: "tool_result",
        data: {
          id, name, status: failed ? "error" : "done", output: "",
          error: failed ? (errored?.message || `Codex reported ${item.tool} as ${status}`) : ""
        }
      });
      return out;
    }

    // An item THIS class does not know yet — the server declares 19 and the branches
    // above draw 6. The pane is a re-render of the CLI's TUI, so the item still reaches
    // it, whole and under the server's own name; the `done` guard is the same one the
    // exec transport applies, so an item announced and completed is one record, not two.
    //
    // Two items are excluded because something else already drew them: `agentMessage`
    // streams as `item/agentMessage/delta`, and `userMessage` is the prompt the pane
    // prints when it is sent — carrying either again would show it twice.
    if (item.type === "agentMessage" || item.type === "userMessage") return out;
    if (done) out.push({ event: "cli_event", data: { type: item.type || "", subtype: status || "", record: item } });
    return out;
  }

  _handleExit(info) {
    if (this.closed) return;
    this.isTurnRunning = false;
    // Nothing is left to answer a gate on a server that is gone.
    this.gates.clear();
    this.onEvent?.("error", { message: `Codex app-server exited (code ${info?.code ?? "?"})` });
    this.onEvent?.("turn_complete", { stats: {} });
  }

  /** Handshake: negotiate, then open or rejoin a thread. */
  async start() {
    // `experimentalApi` is required or `thread/settings/update` and
    // `collaborationMode/list` answer -32600 — every mid-chat option would be refused.
    await this.rpc.request("initialize", {
      clientInfo: { name: "9remote", title: "9Remote", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    }, { timeoutMs: REQUEST_TIMEOUT_MS });

    const params = {
      cwd: this.cwd,
      sandboxPolicy: this.settings.sandboxPolicy,
      approvalPolicy: this.settings.approvalPolicy,
      collaborationMode: this.settings.collaborationMode || collaborationModeFor({ planMode: this.planMode, model: this.model, effort: this.effort, planEffort: this.planEffort }),
      ...(this.model ? { model: this.model } : {}),
      ...(this.personality ? { personality: this.personality } : {})
    };

    // A resumed thread is rejoined, never re-created: `thread/start` on an existing id
    // would open a second thread and orphan the conversation the user came back to.
    const res = this.threadId
      ? await this.rpc.request("thread/resume", { ...params, threadId: this.threadId }, { timeoutMs: REQUEST_TIMEOUT_MS })
      : await this.rpc.request("thread/start", params, { timeoutMs: REQUEST_TIMEOUT_MS });

    this.threadId = res?.thread?.id || this.threadId;

    // Whatever was picked while the handshake was in flight goes now, in one call.
    const held = this.pendingSettings;
    this.pendingSettings = {};
    if (Object.keys(held).length) await this.updateSettings(held);

    return this.threadId;
  }

  /**
   * Change the live thread's options. `thread/start` cannot: it is past, and the server
   * is still running with what it opened with.
   *
   * Probed on the real server — sandbox, approval, effort, personality, model and
   * collaborationMode all take effect here immediately. That is what keeps changing the
   * mode mid-chat working the way it did when every turn was its own process.
   */
  async updateSettings(patch = {}) {
    if (!this.threadId) {
      // No thread yet. Held, not dropped: the handshake is a second away and losing the
      // setting would run the turn at the policy the user already changed.
      Object.assign(this.pendingSettings, patch);
      return false;
    }
    await this.rpc.request("thread/settings/update", { threadId: this.threadId, ...patch }, { timeoutMs: REQUEST_TIMEOUT_MS });
    return true;
  }

  /** The options this chat runs with, in one place, for both the thread and each turn. */
  applyOptions(opts = {}) {
    // Remembered, not just applied: a later call that changes only the mode would
    // otherwise rebuild the policy with the defaults and silently drop the roots.
    if (opts.networkAccess !== undefined) this.networkAccess = Boolean(opts.networkAccess);
    if (opts.addDirs !== undefined) this.addDirs = (opts.addDirs || []).filter((d) => typeof d === "string" && d);

    if (opts.mode !== undefined || opts.networkAccess !== undefined || opts.addDirs !== undefined) {
      // A mode wins over the raw sandbox name when both are held — a mode is the user's
      // own choice, the sandbox name is only how the exec transport spells one.
      if (opts.mode !== undefined) this.permissionMode = opts.mode;
      this.settings.sandboxPolicy = sandboxPolicyFor({
        mode: this.permissionMode,
        sandbox: this.sandboxName,
        networkAccess: this.networkAccess,
        addDirs: this.addDirs
      });
      this.settings.approvalPolicy = approvalPolicyFor({ mode: this.permissionMode });
    }
    if (opts.planMode !== undefined) this.planMode = Boolean(opts.planMode);
    if (opts.planEffort !== undefined) this.planEffort = opts.planEffort || "";
    if (opts.model !== undefined) this.model = opts.model || "";
    if (opts.effort !== undefined) this.effort = opts.effort || "";
    if (opts.personality !== undefined) this.personality = opts.personality || "";

    const collaborationMode = collaborationModeFor({
      planMode: this.planMode, model: this.model, effort: this.effort, planEffort: this.planEffort
    });
    const changed = { sandboxPolicy: this.settings.sandboxPolicy, approvalPolicy: this.settings.approvalPolicy, collaborationMode };
    if (this.model) changed.model = this.model;
    if (this.effort) changed.effort = this.effort;
    if (this.personality) changed.personality = this.personality;
    this.settings.collaborationMode = collaborationMode;
    return changed;
  }

  /**
   * A prompt as the turn's input. An image is its own `localImage` entry (the exec path
   * spelled it `--image=<path>`); the server takes no file input at all, so anything
   * else is named in the text for the agent to read itself.
   */
  _turnInput(prompt, attachments = []) {
    const text = String(prompt ?? "");
    const input = [];
    const others = [];
    for (const a of attachments || []) {
      if (!a?.path) continue;
      if (a.kind === "image") input.push({ type: "localImage", path: a.path });
      else others.push(a.path);
    }
    // An empty text entry is not a message: an image-only turn (the exec path accepted
    // one too) would otherwise carry a blank line the model has to read past.
    const body = [text, ...others.map((p) => `@${p}`)].filter(Boolean).join("\n");
    if (body || !input.length) input.unshift({ type: "text", text: body, text_elements: [] });
    return input;
  }

  sendPrompt(prompt, attachments = []) {
    if (this.closed) return Promise.reject(new Error("Codex app-server has been closed"));
    if (this.isTurnRunning) return Promise.reject(new Error("Codex turn is already running."));
    this.isTurnRunning = true;
    // `/review` is a COMMAND of this server, not prose: `review/start` runs the review
    // (measured — it emits the enteredReviewMode -> command -> exitedReviewMode trio),
    // while the same text sent as a prompt just asks the model to review something and
    // gets an apology when the tree is clean. `target` is the server's union; uncommitted
    // changes are what the TUI's own /review looks at.
    if (String(prompt).trim() === "/review") {
      return this.rpc.request("review/start", {
        threadId: this.threadId,
        target: { type: "uncommittedChanges" }
      });
    }
    return this.rpc.request("turn/start", {
      threadId: this.threadId,
      input: this._turnInput(prompt, attachments),
      // Repeated on the turn so a mode change lands even if the settings call was
      // refused: an option the user picked must not wait for the next chat.
      ...this._turnOverrides()
    });
  }

  /** The turn-level echo of the live settings — sandbox/approval/effort/personality/model. */
  _turnOverrides() {
    const out = {};
    if (this.settings.sandboxPolicy) out.sandboxPolicy = this.settings.sandboxPolicy;
    if (this.settings.approvalPolicy) out.approvalPolicy = this.settings.approvalPolicy;
    if (this.model) out.model = this.model;
    if (this.effort) out.effort = this.effort;
    if (this.personality) out.personality = this.personality;
    return out;
  }

  interrupt() {
    if (!this.threadId || this.closed) return;
    this.rpc.request("turn/interrupt", { threadId: this.threadId }, { timeoutMs: REQUEST_TIMEOUT_MS }).catch(() => {});
  }

  /**
   * Answer a gate the server is holding on, by the id the request carried.
   *
   * The decision vocabulary is the server's own: `accept` / `acceptForSession` / `decline`
   * / `cancel` (checked against its generated bindings). It is NOT approve/deny, and the
   * CLI rejects a value it does not know — which would leave the turn blocked while the
   * app believed it had answered.
   */
  resolvePermission(requestId, behavior, message = "") {
    if (!requestId) return false;
    const gate = this.gates.get(String(requestId));
    if (!this.gates.delete(String(requestId))) return false;
    // A permission GRANT answers with what it granted, not with a decision — the two
    // response shapes are the server's, and sending a `decision` to this one is a refusal
    // it cannot read. Allow echoes back the profile that was asked for, for this turn
    // only: a wider scope would quietly outlive the thing that needed it.
    const answer = gate?.input?.kind === "permission_grant"
      ? (behavior === "allow"
        ? { permissions: gate.input.permissions || {}, scope: "turn" }
        : { permissions: {}, scope: "turn" })
      : (behavior === "allow" ? { decision: "accept" } : { decision: "decline" });
    this.rpc.respond(requestId, answer);
    return true;
  }

  async stop() {
    this.closed = true;
    this.isTurnRunning = false;
    this.rpc.close();
  }

  /**
   * Let go of the process WITHOUT ending the session.
   *
   * A restart replaces the server under a chat that is staying; the old one's exit is
   * the restart itself, not the chat dying. Without this the adapter would report an
   * error and end a turn nobody ended — and the replacement's process had not started
   * yet, so there would be nothing to carry on with.
   */
  detach() {
    this.closed = true;
    this.isTurnRunning = false;
    this.rpc.detach();
  }
}
