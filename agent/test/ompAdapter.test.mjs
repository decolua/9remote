// ompAdapter normalization: AgentSessionEvent frames → the pane's vocabulary,
// approval/ask dialogs → the shared gates, subagent lifecycle → harness rows.
// Run: node agent/test/ompAdapter.test.mjs
import assert from "node:assert/strict";
import { OmpAdapter } from "../features/ai/adapters/ompAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

function makeAdapter() {
  const events = [];
  const ui = { values: [], confirms: [] };
  const adapter = new OmpAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  // A silent rpc: start flows are exercised by the e2e; unit scope is frames.
  adapter.rpc = {
    uiRespondValue: (id, value) => ui.values.push({ id, value }),
    uiRespondConfirm: (id, confirmed) => ui.confirms.push({ id, confirmed }),
    send: () => new Promise(() => {}),
    close: () => {},
  };
  const feed = (frame) => adapter._onFrame(frame);
  return { adapter, events, ui, feed, of: (name) => events.filter(([e]) => e === name) };
}

console.log("Running omp adapter tests...");

test("text and thinking deltas stream through", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi " } });
  feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "there" } });
  feed({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
  assert.deepEqual(of("delta").map(([, d]) => d.text), ["hi ", "there"]);
  assert.deepEqual(of("thinking").map(([, d]) => d.text), ["hmm"]);
});

test("a write tool lands a diff card beside its row", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "/tmp/a.ts", content: "export {}\n" } });
  feed({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", result: { content: [{ type: "text", text: "written" }] } });
  assert.equal(of("tool_start")[0][1].name, "write");
  assert.equal(of("tool_result")[0][1].output, "written");
  const [diff] = of("diff");
  assert.equal(diff[1].file, "/tmp/a.ts");
  assert.match(diff[1].content, /export \{\}/);
});

test("a failed tool surfaces as an error, not a silent done", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "ls" } });
  feed({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "boom" }] } });
  assert.equal(of("tool_result")[0][1].status, "error");
  assert.match(of("tool_result")[0][1].error, /boom/);
  assert.equal(of("diff").length, 0);
});

test("assistant usage accumulates into stats with a context denominator", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 50, reasoning: 10, contextTokens: 120000, contextWindow: 200000 } } });
  const [s] = of("stats");
  assert.equal(s[1].stats.inputTokens, 100);
  assert.equal(s[1].stats.contextTokens, 120000);
});

test("agent_end ends the turn unless more work is scheduled", () => {
  const { feed, of } = makeAdapter();
  const a = makeAdapter();
  a.adapter.isTurnRunning = true;
  a.feed({ type: "agent_end", isTerminal: false, messages: [] });
  assert.equal(a.of("turn_complete").length, 0);
  assert.equal(a.adapter.isTurnRunning, true);
  feed({ type: "agent_end", messages: [] });
  assert.equal(of("turn_complete").length, 1);
});

test("available_commands_update publishes the '/' menu feed", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "available_commands_update", commands: [
    { name: "review", description: "review changes", source: "builtin" },
    { name: "commit", input: { hint: "message" }, source: "skill" }
  ] });
  const init = of("init").at(-1);
  assert.deepEqual(init[1].commands, [
    { name: "review", description: "review changes" },
    { name: "commit", description: "message" }
  ]);
});

test("a tool-approval select opens the permission gate and answers by value", () => {
  const { feed, of, ui, adapter } = makeAdapter();
  feed({ type: "extension_ui_request", id: "u1", method: "select", title: "Allow tool: bash\nReason: critical", options: ["Approve", "Deny"] });
  const [req] = of("permission_request");
  assert.equal(req[1].tool, "bash");
  assert.equal(adapter.pendingRequests.size, 1);
  assert.equal(adapter.resolvePermission("u1", "allow"), true);
  assert.equal(adapter.resolvePermission("u1", "allow"), false, "answered twice");
  assert.deepEqual(ui.values, [{ id: "u1", value: "Approve" }]);
});

test("an ask-style select becomes a question card and answers with the label", () => {
  const { feed, of, ui, adapter } = makeAdapter();
  feed({ type: "extension_ui_request", id: "u2", method: "select", title: "Deploy where?", options: ["prod", "staging"], optionDetails: [{ description: "live" }, { description: "" }] });
  const [req] = of("permission_request");
  assert.equal(req[1].tool, "AskUserQuestion");
  assert.deepEqual(req[1].input.questions[0].options, [{ label: "prod", description: "live" }, { label: "staging", description: "" }]);
  adapter.resolveQuestion("u2", { "Deploy where?": "staging" });
  assert.deepEqual(ui.values, [{ id: "u2", value: "staging" }]);
});

test("confirm answers yes/no and input answers free text", () => {
  const { feed, ui, adapter } = makeAdapter();
  feed({ type: "extension_ui_request", id: "u3", method: "confirm", title: "Ship?", message: "Deploy now?" });
  adapter.resolveQuestion("u3", { "Deploy now?": "Yes" });
  feed({ type: "extension_ui_request", id: "u4", method: "input", title: "Branch name?" });
  adapter.resolveQuestion("u4", { "Branch name?": "feat/x" });
  assert.deepEqual(ui.confirms, [{ id: "u3", confirmed: true }]);
  assert.deepEqual(ui.values, [{ id: "u4", value: "feat/x" }]);
});

test("a cancelled dialog settles the gate", () => {
  const { feed, of, adapter } = makeAdapter();
  feed({ type: "extension_ui_request", id: "u5", method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"] });
  feed({ type: "extension_ui_request", method: "cancel", targetId: "u5" });
  assert.equal(of("permission_resolved").length, 1);
  assert.equal(adapter.pendingRequests.size, 0);
});

test("a live mode change recycles the process so the next spawn carries the new tier", async () => {  const { adapter, ui } = makeAdapter();
  adapter.activeSessionId = "ses_omp1";
  adapter.rpc = { uiRespondValue: () => {}, uiRespondConfirm: () => {}, send: () => new Promise(() => {}), close: () => { ui.closed = true; } };
  let stopped = false;
  adapter.proc = { stop: async () => { stopped = true; }, start: async () => ({ commit() {} }), onExit: null };
  adapter.setOptions({ mode: "auto" });
  assert.equal(adapter.permissionMode, "auto");
  assert.equal(ui.closed, true, "the old rpc pipe must close");
  assert.equal(stopped, true, "the old process must stop");
  assert.equal(adapter._resumeId, "ses_omp1", "the conversation survives via --resume");
  assert.ok(adapter._stopping, "the next spawn waits for the recycle");
  const spawned = [];
  adapter.proc.start = async (opts) => { spawned.push(opts); return { commit() {} }; };
  adapter._refreshModels = () => {};
  adapter._syncState = () => {};
  await adapter._ensureStarted();
  assert.ok(spawned[0].args.includes("--approval-mode"), "respawn carries the approval flag");
  assert.ok(spawned[0].args.includes("yolo"), "auto maps to yolo");
  assert.ok(spawned[0].args.includes("--resume"), "respawn resumes the conversation");
});

test("Esc still stops when the pane is stale — abort goes out even past a settled flag", () => {
  const { adapter } = makeAdapter();
  const sent = [];
  adapter.rpc = { uiRespondValue: () => {}, uiRespondConfirm: () => {}, send: (type) => { sent.push(type); return new Promise(() => {}); }, close: () => {} };
  adapter.isTurnRunning = false; // the engine ended the turn; the pane missed it
  assert.equal(adapter.interrupt(), true, "a live rpc must accept the stop");
  assert.deepEqual(sent, ["abort"]);
  assert.equal(adapter.isTurnRunning, false);

  // rpc gone: the daemon signal is the fallback, not another interrupt refusal.
  adapter.rpc = null;
  const signals = [];
  adapter.proc = { signal: (s) => signals.push(s) };
  assert.equal(adapter.signal("SIGINT"), true);
  assert.deepEqual(signals, ["SIGINT"]);
});

test("subagent lifecycle rides the harness task rows", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "subagent_lifecycle", payload: { id: "s1", agent: "coder", description: "fix tests", status: "started", index: 0 } });
  feed({ type: "subagent_lifecycle", payload: { id: "s1", status: "completed", index: 0 } });
  const started = of("cli_event").find(([, d]) => d?.subtype === "task_started");
  const done = of("cli_event").find(([, d]) => d?.subtype === "task_notification");
  assert.equal(started[1].task_id, "s1");
  assert.equal(done[1].record.status, "completed");
});

test("compaction, retry and command output become readable rows", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "auto_compaction_start" });
  feed({ type: "auto_compaction_end" });
  feed({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, errorMessage: "rate limited" });
  feed({ type: "command_output", text: "reviewed 3 files" });
  const subtypes = of("cli_event").map(([, d]) => `${d.type}:${d.subtype || ""}`);
  assert.ok(of("cli_event").some(([, d]) => d?.subtype === "status" && d?.record?.status === "compacting"));
  assert.ok(subtypes.some((s) => s.includes("thread/compacted")));
  assert.ok(of("cli_event").some(([, d]) => d?.type === "warning" && /attempt 2\/5/.test(d.record.message)));
  assert.ok(of("cli_event").some(([, d]) => d?.subtype === "local_command" && /reviewed 3 files/.test(d.record.content)));
});

test("session ids and model changes publish on init", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "session_info_update", sessionId: "01a0bf61-abc", title: "t" });
  feed({ type: "config_update", model: "anthropic/claude-sonnet-5", thinkingLevel: "high" });
  const init = of("init").at(-1);
  assert.equal(init[1].sessionId, "01a0bf61-abc");
  assert.equal(init[1].model, "anthropic/claude-sonnet-5");
  assert.equal(init[1].effort, "high");
});


test("the DaemonProc hold is committed: startup lines reach the client (audited)", async () => {
  // DaemonProc holds the spawn's lines until commit() — skip it and the ready
  // frame starves while every later line piles into the hold. Reproduced by audit.
  const written = [];
  const proc = {
    onLine: null,
    onExit: null,
    write: (t) => { written.push(t); return true; },
    closeStdin: () => {},
    start: async () => ({
      lines: [Buffer.from(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] })).toString("base64")],
      commit: (feed) => feed(Buffer.from(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] })).toString("base64")),
      release: () => {},
    }),
  };
  const adapter = new OmpAdapter({ cwd: "/tmp", onEvent: () => {} });
  Object.assign(adapter.proc, { start: proc.start, write: proc.write });
  await adapter._ensureStarted();
  assert.ok(written.some((w) => w.includes("negotiate_protocol")), "the committed ready frame must trigger v2 negotiation");
  adapter.rpc && adapter.rpc.pending.clear();
});

test("an edit tool using old_string / new_string lands a diff card", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "tool_execution_start", toolCallId: "t-edit", toolName: "edit", args: { path: "/tmp/a.js", old_string: "const x = 1;", new_string: "const x = 2;" } });
  feed({ type: "tool_execution_end", toolCallId: "t-edit", toolName: "edit", isError: false, result: { content: [{ type: "text", text: "ok" }] } });
  const [diff] = of("diff");
  assert.ok(diff, "diff card must be emitted for edit");
  assert.equal(diff[1].file, "/tmp/a.js");
  assert.ok(diff[1].patch.includes("-const x = 1;"));
  assert.ok(diff[1].patch.includes("+const x = 2;"));
});

test("a todo tool with committed phases updates the checklist", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "tool_execution_start", toolCallId: "t-todo", toolName: "todo", args: { op: "init" } });
  feed({
    type: "tool_execution_end",
    toolCallId: "t-todo",
    toolName: "todo",
    isError: false,
    result: { details: { op: "init", phases: [{ name: "Phase 1", tasks: [{ content: "Task A", status: "completed" }, { content: "Task B", status: "in_progress" }] }] } }
  });
  const todos = of("tool_start").filter(([, d]) => d.name === "todowrite");
  assert.equal(todos.length, 1);
  assert.equal(todos[0][1].input.todos.length, 2);
  assert.equal(todos[0][1].input.todos[0].content, "Task A");
  assert.equal(todos[0][1].input.todos[0].status, "completed");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
