// hermesAdapter normalization: ACP session updates → the pane's vocabulary,
// permissions → shared gates, plan → task checklist.
// Run: node agent/test/hermesAdapter.test.mjs
import assert from "node:assert/strict";
import { HermesAdapter } from "../features/ai/adapters/hermesAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

function makeAdapter() {
  const events = [];
  const responses = [];
  const adapter = new HermesAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  adapter.rpc = {
    respond: (id, result) => responses.push({ id, result }),
    notify: () => true,
    request: () => Promise.resolve({}),
    close: () => {}
  };
  const feed = (update) => adapter._onUpdate(update);
  return { adapter, events, responses, feed, of: (name) => events.filter(([e]) => e === name) };
}

console.log("Running hermes adapter tests...");

test("session/new absorbs model options, active model, and mode", () => {
  const { adapter } = makeAdapter();
  adapter._absorbSession({
    sessionId: "hermes-sess-1",
    models: {
      currentModelId: "custom:ag/gemini-3.8-flash-high",
      availableModels: [
        { modelId: "custom:ag/gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
        { modelId: "openrouter:anthropic/claude-sonnet-4", name: "Claude Sonnet 4" }
      ]
    },
    modes: { currentModeId: "accept_edits" }
  });
  assert.equal(adapter.activeSessionId, "hermes-sess-1");
  assert.equal(adapter.metadata.sessionId, "hermes-sess-1");
  assert.equal(adapter.metadata.model, "custom:ag/gemini-3.8-flash-high");
  assert.equal(adapter.metadata.permissionMode, "accept_edits");
  assert.equal(adapter.metadata.modelOptions.length, 2);
  assert.equal(adapter.metadata.modelOptions[0].provider, "custom");
  assert.equal(adapter.metadata.modelOptions[1].provider, "openrouter");
});

test("text and thought chunks stream through", () => {
  const { feed, of } = makeAdapter();
  feed({ sessionUpdate: "agent_message_chunk", content: { text: "Xin chào " } });
  feed({ sessionUpdate: "agent_message_chunk", content: { text: "bạn!" } });
  feed({ sessionUpdate: "agent_thought_chunk", content: { text: "thinking..." } });
  assert.deepEqual(of("delta").map(([, d]) => d.text), ["Xin chào ", "bạn!"]);
  assert.deepEqual(of("thinking").map(([, d]) => d.text), ["thinking..."]);
});

test("tool call maps title prefix to canonical tool name", () => {
  const { feed, of } = makeAdapter();
  feed({
    sessionUpdate: "tool_call",
    toolCallId: "tc-1",
    title: "terminal: ls -la",
    kind: "execute",
    rawInput: { command: "ls -la" }
  });
  feed({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-1",
    status: "completed",
    content: [{ content: { text: "total 0\n" } }]
  });
  const starts = of("tool_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0][1].name, "terminal");
  assert.equal(starts[0][1].input.command, "ls -la");

  const results = of("tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0][1].status, "done");
  assert.equal(results[0][1].output, "total 0\n");
});

test("write tool with diff content emits diff card event", () => {
  const { feed, of } = makeAdapter();
  feed({
    sessionUpdate: "tool_call",
    toolCallId: "tc-2",
    title: "write: index.js",
    kind: "edit",
    content: [{ type: "diff", path: "index.js", oldText: "console.log(1);", newText: "console.log(2);" }],
    rawInput: { path: "index.js", content: "console.log(2);" }
  });
  const diffs = of("diff");
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0][1].file, "index.js");
  assert.equal(diffs[0][1].name, "write_file");

  feed({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-2",
    status: "completed",
    content: [{ type: "diff", path: "index.js", oldText: "console.log(1);", newText: "console.log(2);" }]
  });
  assert.equal(of("tool_result")[0][1].status, "done");
});

test("tool failure marks status error", () => {
  const { feed, of } = makeAdapter();
  feed({
    sessionUpdate: "tool_call",
    toolCallId: "tc-3",
    title: "read: missing.txt",
    kind: "read",
    rawInput: { path: "missing.txt" }
  });
  feed({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-3",
    status: "failed",
    content: [{ content: { text: "File not found" } }]
  });
  const results = of("tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0][1].status, "error");
  assert.equal(results[0][1].error, "File not found");
});

test("plan update translates into synthetic todo_list tool call", () => {
  const { feed, of } = makeAdapter();
  feed({
    sessionUpdate: "plan",
    entries: [
      { content: "Explore code", status: "completed" },
      { content: "Implement adapter", status: "in_progress" },
      { content: "Run test", status: "pending" }
    ]
  });
  const starts = of("tool_start");
  const results = of("tool_result");
  assert.equal(starts.length, 1);
  assert.equal(starts[0][1].name, "todo_list");
  assert.equal(starts[0][1].input.todos.length, 3);
  assert.equal(starts[0][1].input.todos[1].content, "Implement adapter");
  assert.equal(starts[0][1].input.todos[1].status, "in_progress");
  assert.equal(results.length, 1);
  assert.equal(results[0][1].status, "done");
});

test("usage_update updates context window and used tokens", () => {
  const { feed, adapter, of } = makeAdapter();
  feed({ sessionUpdate: "usage_update", size: 128000, used: 45000 });
  assert.equal(adapter.stats.contextWindow, 128000);
  assert.equal(adapter.stats.contextTokens, 45000);
  assert.equal(of("stats").length, 1);
});

test("permission request and resolve mapping", () => {
  const { adapter, of, responses } = makeAdapter();
  adapter._onPermission({
    toolCall: {
      title: "terminal: rm -rf /tmp/test",
      rawInput: { command: "rm -rf /tmp/test" }
    },
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
      { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
      { optionId: "deny", kind: "reject_once", name: "Deny" }
    ]
  }, 101);

  const reqs = of("permission_request");
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0][1].requestId, 101);
  assert.equal(reqs[0][1].tool, "terminal");

  // allowAlways resolves to allow_session (or allow_always if available)
  const resolved = adapter.resolvePermission(101, "allowAlways");
  assert.equal(resolved, true);
  assert.deepEqual(responses[0], {
    id: 101,
    result: { outcome: { outcome: "selected", optionId: "allow_session" } }
  });
});

test("finish turn aggregates usage into stats and clears turn", () => {
  const { adapter, of } = makeAdapter();
  adapter.isTurnRunning = true;
  adapter._finishTurn({
    stopReason: "end_turn",
    usage: {
      prompt_tokens: 500,
      completion_tokens: 120,
      thought_tokens: 45,
      cached_read_tokens: 200
    }
  });
  assert.equal(adapter.isTurnRunning, false);
  assert.equal(adapter.stats.inputTokens, 500);
  assert.equal(adapter.stats.outputTokens, 120);
  assert.equal(adapter.stats.reasoningTokens, 45);
  assert.equal(adapter.stats.cachedTokens, 200);
  assert.equal(adapter.stats.totalTurns, 1);

  const completes = of("turn_complete");
  assert.equal(completes.length, 1);
  assert.equal(completes[0][1].isError, false);
});

test("midTurn detects in-flight turn vs idle state", () => {
  const { adapter } = makeAdapter();
  const updateLine = JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } });
  const endLine = JSON.stringify({ result: { stopReason: "end_turn" } });

  assert.equal(adapter._midTurn([updateLine]), true);
  assert.equal(adapter._midTurn([updateLine, endLine]), false);
  assert.equal(adapter._midTurn([]), false);
});

test("dont_ask mode rides the spawn as --yolo; other modes do not", () => {
  const { adapter } = makeAdapter();
  adapter.setOptions({ mode: "dont_ask" });
  assert.deepEqual(adapter._spawnArgs(), ["--yolo", "acp", "--accept-hooks"]);

  const calm = makeAdapter();
  calm.adapter.setOptions({ mode: "default" });
  assert.deepEqual(calm.adapter._spawnArgs(), ["acp", "--accept-hooks"]);
});

test("an unknown effort value is ignored, a config-equal one updates metadata only", async () => {
  const { adapter } = makeAdapter();
  adapter.setOptions({ effort: "bogus" });
  assert.equal(adapter.metadata.effort, "");
  assert.equal(adapter._stopping, null);

  // "medium" is what config.yaml holds on this host (resolveDefaultEffort) — the
  // write-and-recycle path must NOT fire for it.
  const { resolveDefaultEffort } = await import("../features/ai/models.js");
  const current = resolveDefaultEffort("hermes");
  if (current) {
    adapter.setOptions({ effort: current });
    assert.equal(adapter.metadata.effort, current);
    assert.equal(adapter._stopping, null);
  }
});

test("crossing the dont_ask line on a live process recycles it", () => {
  const { adapter } = makeAdapter();
  adapter._spawnedYolo = false;
  let closed = false;
  adapter.rpc.close = () => { closed = true; };
  adapter.setOptions({ mode: "dont_ask" });
  assert.equal(closed, true);
  assert.equal(adapter.rpc, null);
  assert.equal(adapter.metadata.permissionMode, "dont_ask");
});

test("the model catalog rides only the first init", () => {
  const { adapter, events } = makeAdapter();
  adapter._absorbSession({ sessionId: "s1", models: { availableModels: [{ modelId: "p:m", name: "M" }] } });
  adapter._emitInit();
  adapter._emitInit();
  const inits = events.filter(([e]) => e === "init");
  assert.equal(inits[0][1].modelOptions.length, 1);
  assert.equal(inits[1][1].modelOptions, undefined);
});

if (fail > 0) {
  console.error(`\n${fail} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${pass} tests passed.`);
}
