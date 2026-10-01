// PiAdapter normalization: pi --mode rpc frames → the pane's shared vocabulary.
// Pi shares its wire with omp minus subagents/ready-chunking, plus pi-specific
// names (compaction_*, fork rewind, editor dialog). Inherited omp behavior is
// re-asserted here only where the pi wire exercises it differently.
// Run: node test/piAdapter.test.mjs
import assert from "node:assert/strict";
import { PiAdapter } from "../features/ai/adapters/piAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

function makeAdapter() {
  const events = [];
  const sent = [];
  const ui = { values: [], confirms: [], cancels: [] };
  const adapter = new PiAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  adapter.rpc = {
    uiRespondValue: (id, value) => ui.values.push({ id, value }),
    uiRespondConfirm: (id, confirmed) => ui.confirms.push({ id, confirmed }),
    uiRespondCancel: (id) => ui.cancels.push({ id }),
    send: (type, payload) => { sent.push([type, payload]); return Promise.resolve({}); },
    close: () => {},
  };
  const feed = (frame) => adapter._onFrame(frame);
  return { adapter, events, ui, sent, feed, of: (name) => events.filter(([e]) => e === name) };
}

console.log("Running pi adapter tests...");

test("spawn args: rpc mode, session resume, no omp approval flag", () => {
  const { adapter } = makeAdapter();
  adapter.currentModel = "anthropic/claude-sonnet-4-5";
  adapter._resumeId = "abc123";
  assert.deepEqual(adapter._args(), ["--mode", "rpc", "--model", "anthropic/claude-sonnet-4-5", "--session", "abc123"]);
});

test("doctor checks the pi binary", () => {
  assert.deepEqual(PiAdapter.doctorSpec(), { command: "pi", args: ["--version"] });
});

test("text and thinking deltas stream through", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  feed({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
  assert.deepEqual(of("delta").map(([, d]) => d.text), ["hi"]);
  assert.deepEqual(of("thinking").map(([, d]) => d.text), ["hmm"]);
});

test("a write tool lands a diff card beside its row", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "a.txt", content: "x" } });
  feed({ type: "tool_execution_end", toolCallId: "c1", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  const diff = of("diff")[0];
  assert.ok(diff, "diff event emitted");
  assert.equal(diff[1].file, "a.txt");
});

test("pi's multi-edit lands one hunk per replacement", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: { path: "b.txt", edits: [
    { oldText: "a", newText: "b" },
    { oldText: "c\nd", newText: "e" },
  ] } });
  feed({ type: "tool_execution_end", toolCallId: "c2", toolName: "edit", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  const hunks = of("diff")[0][1];
  assert.ok(Array.isArray(hunks) && hunks.length === 2, "one hunk per edit");
  assert.deepEqual([hunks[0].patch, hunks[1].patch], ["-a\n+b", "-c\n-d\n+e"]);
});

test("pi's compaction_* frames carry the compacting status", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "compaction_start", reason: "threshold" });
  feed({ type: "compaction_end", reason: "threshold", result: {}, aborted: false, willRetry: false });
  assert.equal(of("cli_event").filter(([e, d]) => d.type === "system" && d.subtype === "status")[0][1].record.status, "compacting");
  assert.ok(of("cli_event").some(([, d]) => d.type === "thread/compacted"));
});

test("agent_end settles the turn", () => {
  const { adapter, feed, of } = makeAdapter();
  adapter.isTurnRunning = true;
  feed({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(adapter.isTurnRunning, false);
  assert.equal(of("turn_complete").length, 1);
});

test("a retrying agent_end keeps the turn open until settled", () => {
  const { adapter, feed, of } = makeAdapter();
  adapter.isTurnRunning = true;
  feed({ type: "agent_end", messages: [], willRetry: true });
  assert.equal(adapter.isTurnRunning, true, "retry pending — still running");
  assert.equal(of("turn_complete").length, 0);
  feed({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(of("turn_complete").length, 1);
  feed({ type: "agent_settled" });
  assert.equal(of("turn_complete").length, 1, "settled after end is a no-op");
});

test("agent_settled alone ends a turn whose agent_end was lost", () => {
  const { adapter, feed, of } = makeAdapter();
  adapter.isTurnRunning = true;
  feed({ type: "agent_settled" });
  assert.equal(adapter.isTurnRunning, false);
  assert.equal(of("turn_complete").length, 1);
});

test("retry end without success warns with the final error", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "auto_retry_end", success: false, attempt: 3, finalError: "401 bad key" });
  const warn = of("cli_event").filter(([e, d]) => d.type === "warning").pop();
  assert.ok(warn && String(warn[1].record.message).includes("401 bad key"));
});

test("approve/deny select rides the permission gate", () => {
  const { feed, of, adapter } = makeAdapter();
  feed({ type: "extension_ui_request", id: "q1", method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"] });
  const req = of("permission_request")[0];
  assert.equal(req[1].tool, "bash");
  assert.equal(adapter.resolvePermission("q1", "allow"), true);
});

test("editor dialog maps onto the question gate", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "extension_ui_request", id: "q2", method: "editor", title: "Edit the plan", prefill: "x" });
  const req = of("permission_request")[0];
  assert.equal(req[1].tool, "AskUserQuestion");
  assert.equal(req[1].input.questions[0].question, "Edit the plan");
});

test("rewind rides pi's fork commands", async () => {
  const { adapter, sent } = makeAdapter();
  adapter.rpc.send = (type) => type === "get_fork_messages"
    ? Promise.resolve({ messages: [{ entryId: "e1", text: "first prompt" }] })
    : Promise.resolve({});
  const points = await adapter.branchPoints();
  assert.deepEqual(points, [{ messageId: "e1", text: "first prompt" }]);
  await adapter.rewindConversation("e1");
  assert.deepEqual(sent.map(([t]) => t).filter((t) => t === "fork"), ["fork"]);
});

test("stats accumulate from message_end usage", () => {
  const { feed, of } = makeAdapter();
  feed({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5, reasoningTokens: 2 } } });
  assert.equal(of("stats").length, 1);
});

test("/compact rides the rpc command, not the LLM", async () => {
  const { adapter, sent } = makeAdapter();
  adapter.rpc.send = (type, payload) => { sent.push([type, payload]); return Promise.resolve({}); };
  adapter.sendPrompt("/compact");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent.filter(([t]) => t === "compact"), [["compact", {}]]);
  assert.equal(adapter.isTurnRunning, false, "no agent turn for a local command");
});

test("/compact carries custom instructions, /name renames the session", async () => {
  const { adapter, sent } = makeAdapter();
  adapter.rpc.send = (type, payload) => { sent.push([type, payload]); return Promise.resolve({}); };
  adapter.sendPrompt("/compact focus on API changes");
  adapter.sendPrompt("/name my-session");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent.find(([t]) => t === "compact"), ["compact", { customInstructions: "focus on API changes" }]);
  assert.deepEqual(sent.find(([t]) => t === "set_session_name"), ["set_session_name", { name: "my-session" }]);
});

test("a normal prompt still reaches the agent loop", () => {
  const { adapter, events } = makeAdapter();
  adapter.sendPrompt("hello");
  assert.equal(adapter.isTurnRunning, true);
  assert.equal(events.length, 0, "no error/release events on the way in");
});

test("/session answers locally from get_session_stats", async () => {
  const { adapter, events } = makeAdapter();
  adapter.rpc.send = (type) => type === "get_session_stats"
    ? Promise.resolve({
      sessionId: "abc", sessionFile: "/tmp/s.jsonl",
      totalMessages: 22, userMessages: 5, assistantMessages: 5, toolResults: 12,
      tokens: { input: 50, output: 10, cacheRead: 40, cacheWrite: 5, total: 105 },
      cost: 0.45, contextUsage: { tokens: 60, contextWindow: 200, percent: 30 }
    })
    : Promise.resolve({});
  adapter.sendPrompt("/session");
  await new Promise((r) => setTimeout(r, 10));
  const row = events.find(([e, d]) => e === "cli_event" && d.subtype === "local_command");
  assert.ok(row, "local command row emitted");
  const text = row[1].record.content;
  for (const part of ["abc", "/tmp/s.jsonl", "22 (5 user", "Tokens: 105", "Cost: $0.45", "Context: 60/200 (30%)"]) {
    assert.ok(text.includes(part), `stats text misses "${part}"`);
  }
});

test("/clone duplicates the branch without opening a turn", async () => {
  const { adapter, sent } = makeAdapter();
  adapter.rpc.send = (type) => { sent.push(type); return Promise.resolve({}); };
  adapter.sendPrompt("/clone");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.includes("clone"));
  assert.equal(adapter.isTurnRunning, false);
});

test("get_state's live model reaches the pane metadata", async () => {
  const { adapter } = makeAdapter();
  adapter.rpc.send = (type) => type === "get_state"
    ? Promise.resolve({ model: { id: "claude-fable-5", provider: "anthropic" }, isStreaming: false, sessionId: "s1" })
    : Promise.resolve({});
  await adapter._syncState();
  assert.equal(adapter.metadata.model, "anthropic/claude-fable-5");
  assert.equal(adapter.currentModel, "anthropic/claude-fable-5");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
