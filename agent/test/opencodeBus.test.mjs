// The opencode serve event bus (v2, GET /api/event) → the pane's event vocabulary.
//
// Every fixture here is recorded from a real `opencode serve` turn (1.18.31, a
// write-tool turn on a free model), trimmed to the fields the parser reads. The
// envelope on the wire is {id, type, data, durable?, location?}; only `type` and
// `data` matter here. session.next.* is the CLI's own TUI bus — see
// .source/opencode packages/schema/src/session-event.ts.
//
// Run: node agent/test/opencodeBus.test.mjs
import assert from "node:assert/strict";
import { createOpencodeBusParser } from "../features/ai/opencodeBus.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const SID = "ses_f5034813affeImc57WjT63gD3W";
const CALL = "64c82dc4-e7f9-458f-8f80-70522b8365dd";
const env = (type, data = {}) => ({ id: "evt_x", type, data: { sessionID: SID, ...data } });

// Replay recorded envelopes through a parser and collect what it emitted.
function parse(envelopes, stats = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTurns: 0 }) {
  const events = [];
  const parser = createOpencodeBusParser({ onEvent: (e, d) => events.push([e, d]), stats });
  for (const e of envelopes) parser.handle(e);
  return { events, of: (name) => events.filter(([e]) => e === name), stats };
}

console.log("Running opencode bus parser tests...");

test("a recorded write turn streams its tool live, then its text, then ends on finish=stop", () => {
  const { events, of } = parse([
    env("session.next.prompt.admitted", { messageID: "msg_u" }),
    env("session.next.prompted", { messageID: "msg_u" }),
    env("session.next.step.started", { assistantMessageID: "msg_a1", agent: "build", model: { id: "union-alpha", providerID: "opencode" } }),
    env("session.next.tool.input.started", { assistantMessageID: "msg_a1", callID: CALL, name: "write" }),
    env("session.next.tool.input.delta", { callID: CALL, delta: "{\"conte" }),
    env("session.next.tool.input.ended", { callID: CALL, text: "{\"content\": \"x\", \"path\": \"t7.txt\"}" }),
    env("session.next.tool.called", { callID: CALL, tool: "write", input: { content: "x", path: "t7.txt" } }),
    env("session.next.tool.success", {
      callID: CALL,
      structured: { operation: "write", target: "/private/tmp/oc-probe2/t7.txt" },
      content: [{ type: "text", text: "Created file successfully: t7.txt" }]
    }),
    // The model called a tool — another step follows, the turn is NOT over.
    env("session.next.step.ended", { assistantMessageID: "msg_a1", finish: "tool-calls", cost: 0, tokens: { input: 2731, output: 65, reasoning: 0, cache: { read: 0, write: 0 } } }),
    env("session.next.context.updated", { messageID: "msg_sys", text: "Skills provide specialized instructions…" }),
    env("session.next.step.started", { assistantMessageID: "msg_a2", agent: "build", model: { id: "union-alpha", providerID: "opencode" } }),
    env("session.next.text.started", { assistantMessageID: "msg_a2", textID: "text-0" }),
    env("session.next.text.delta", { assistantMessageID: "msg_a2", textID: "text-0", delta: "done" }),
    env("session.next.text.ended", { assistantMessageID: "msg_a2", textID: "text-0", text: "done" }),
    env("session.next.step.ended", { assistantMessageID: "msg_a2", finish: "stop", cost: 0, tokens: { input: 4554, output: 56, reasoning: 0, cache: { read: 0, write: 0 } } })
  ]);
  // The tool row is announced while its input is still streaming, then settles.
  const [start] = of("tool_start");
  assert.equal(start[1].id, CALL);
  assert.equal(start[1].name, "write");
  assert.equal(start[1].status, "running");
  const settled = of("tool_start").at(-1);
  assert.deepEqual(settled[1].input, { content: "x", path: "t7.txt" });
  const [result] = of("tool_result");
  assert.equal(result[1].status, "done");
  assert.equal(result[1].output, "Created file successfully: t7.txt");
  // The landed write draws its diff — the v2 write tool names the target `path`.
  const [diff] = of("diff");
  assert.deepEqual(diff[1], { file: "t7.txt", name: "write", patch: "", content: "x" });
  // Text streamed, and `tool-calls` did NOT end the turn — only `stop` did.
  assert.equal(of("delta").map(([, d]) => d.text).join(""), "done");
  assert.equal(of("turn_complete").length, 1);
});

test("reasoning deltas draw as thinking", () => {
  const { of } = parse([
    env("session.next.reasoning.started", { assistantMessageID: "m", reasoningID: "r-0" }),
    env("session.next.reasoning.delta", { assistantMessageID: "m", reasoningID: "r-0", delta: "consider" }),
    env("session.next.reasoning.delta", { assistantMessageID: "m", reasoningID: "r-0", delta: "ing…" }),
    env("session.next.reasoning.ended", { assistantMessageID: "m", reasoningID: "r-0" })
  ]);
  assert.equal(of("thinking").map(([, d]) => d.text).join(""), "considering…");
});

test("a failed tool stays an error row, and its edit draws no diff", () => {
  const { of } = parse([
    env("session.next.tool.input.started", { callID: "c1", name: "edit" }),
    env("session.next.tool.called", { callID: "c1", tool: "edit", input: { path: "/tmp/a.js", oldString: "x", newString: "y" } }),
    env("session.next.tool.failed", { callID: "c1", error: { type: "unknown", message: "Edit failed: no match" } })
  ]);
  const [result] = of("tool_result");
  assert.equal(result[1].status, "error");
  assert.match(result[1].error, /no match/);
  assert.equal(of("diff").length, 0);
});

test("a provider failure fails the turn", () => {
  const { of } = parse([
    env("session.next.step.started", { assistantMessageID: "m" }),
    env("session.next.step.failed", { assistantMessageID: "m", error: { type: "unknown", message: "Provider returned error" } })
  ]);
  assert.equal(of("error")[0][1].message, "Provider returned error");
  assert.equal(of("turn_complete").length, 0);
});

test("tokens bill per step, and the context holds what the LAST step sent", () => {
  const { stats } = parse([
    env("session.next.step.ended", { finish: "tool-calls", tokens: { input: 10654, output: 55, reasoning: 0, cache: { read: 0, write: 0 } } }),
    env("session.next.step.ended", { finish: "stop", tokens: { input: 8918, output: 44, reasoning: 3, cache: { read: 0, write: 0 } } })
  ]);
  assert.equal(stats.inputTokens, 19572);
  assert.equal(stats.outputTokens, 99);
  assert.equal(stats.reasoningTokens, 3);
  assert.equal(stats.contextTokens, 8918);
  assert.equal(stats.totalTurns, 1);
});

test("every other terminal finish ends the turn, not just stop", () => {
  // The CLI's own closed set (llm/schema/ids.ts): stop, length, tool-calls,
  // content-filter, error, unknown. Anything but tool-calls is the last step.
  for (const finish of ["stop", "length", "content-filter", "error", "unknown"]) {
    const { of } = parse([env("session.next.step.ended", { finish, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })]);
    assert.equal(of("turn_complete").length, 1, `finish=${finish}`);
  }
});

test("a record the parser does not know reaches the pane whole, as cli_event", () => {
  const { of } = parse([
    env("session.next.compaction.ended", { messageID: "m", reason: "auto", text: "summary…", recent: "…" }),
    env("session.next.model.switched", { model: { id: "other", providerID: "opencode" } })
  ]);
  const carried = of("cli_event");
  assert.equal(carried.length, 2);
  assert.equal(carried[0][1].type, "session.next.compaction.ended");
  assert.equal(carried[0][1].record.reason, "auto");
});

test("the harness's own bookkeeping draws nothing", () => {
  const { events } = parse([
    env("session.next.prompt.admitted", {}),
    env("session.next.prompted", {}),
    env("session.next.step.started", { assistantMessageID: "m" }),
    env("session.next.text.started", { textID: "t" }),
    env("session.next.text.ended", { textID: "t", text: "done" }),
    env("session.next.tool.progress", { callID: "c", structured: {}, content: [] }),
    env("session.next.context.updated", { text: "skills reminder" }),
    env("server.heartbeat", {})
  ]);
  assert.equal(events.length, 0);
});

test("session.next.shell events surface as a bash tool call", () => {
  const { of } = parse([
    env("session.next.shell.started", { callID: "sh-1", command: "ls -la", timestamp: 123 }),
    env("session.next.shell.ended", { callID: "sh-1", output: "total 0\n", timestamp: 456 })
  ]);
  const [start] = of("tool_start");
  const [result] = of("tool_result");
  assert.equal(start[1].name, "bash");
  assert.equal(start[1].input.command, "ls -la");
  assert.equal(result[1].name, "bash");
  assert.equal(result[1].output, "total 0\n");
});

test("apply_patch surfaces a diff card with parsed target and changes", () => {
  const patchText = "*** Begin Patch\n*** Update File: src/app.js\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n*** End Patch";
  const { of } = parse([
    env("session.next.tool.called", { callID: "ap-1", tool: "apply_patch", input: { patchText } }),
    env("session.next.tool.success", { callID: "ap-1", tool: "apply_patch", content: [{ text: "Applied patch sequentially:\nM src/app.js" }] })
  ]);
  const [diff] = of("diff");
  assert.ok(diff, "diff event must be emitted for apply_patch");
  assert.equal(diff[1].file, "src/app.js");
  assert.equal(diff[1].name, "apply_patch");
  assert.ok(diff[1].patch.includes("-const a = 1;"));
  assert.ok(diff[1].patch.includes("+const a = 2;"));
});

test("apply_patch with multiple files emits a diff card for each file", () => {
  const patchText = "*** Begin Patch\n*** Update File: src/a.js\n@@ -1,1 +1,1 @@\n-1\n+2\n*** Add File: src/b.js\n+hello\n*** End Patch";
  const { of } = parse([
    env("session.next.tool.called", { callID: "ap-2", tool: "apply_patch", input: { patchText } }),
    env("session.next.tool.success", { callID: "ap-2", tool: "apply_patch", content: [{ text: "Applied patch sequentially:\nM src/a.js\nA src/b.js" }] })
  ]);
  const diffs = of("diff");
  assert.equal(diffs.length, 2);
  assert.equal(diffs[0][1].file, "src/a.js");
  assert.equal(diffs[1][1].file, "src/b.js");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
