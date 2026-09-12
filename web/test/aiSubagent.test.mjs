// Sub-agent tool calls: the host renames the ones carrying a parentToolUseId to
// tool_child / tool_result_child, and the client nests those under the Agent card
// that spawned them instead of floating them loose on the timeline.
// Run: node web/test/aiSubagent.test.mjs
import assert from "node:assert/strict";
import { reduceSessionEvents } from "../features/ai/hooks/useAiSession.js";
import { shellIdFromResult } from "../features/ai/lib/shellId.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running sub-agent nesting tests...");

const log = [
  { event: "user_message", data: { text: "go" } },
  { event: "tool_start", data: { id: "p1", name: "Agent", input: { subagent_type: "Explore" }, status: "running" } },
  { event: "tool_child", data: { id: "c1", name: "Bash", parentToolUseId: "p1", status: "running" } },
  { event: "tool_child", data: { id: "c2", name: "Grep", parentToolUseId: "p1", status: "running" } },
  { event: "tool_result_child", data: { id: "c1", output: "hi", status: "done" } },
  { event: "tool_result", data: { id: "p1", output: "report", status: "done" } },
];

test("a replayed log nests children under their parent card", () => {
  const { messages } = reduceSessionEvents(log, "claude");
  const tools = messages.flatMap((m) => m.tools || []);
  assert.deepEqual(tools.map((t) => t.id), ["p1"], "only the parent is a timeline row");
  assert.deepEqual(tools[0].children.map((c) => c.id), ["c1", "c2"]);
});

test("a child's result lands on the child, not the parent", () => {
  const { messages } = reduceSessionEvents(log, "claude");
  const [parent] = messages.flatMap((m) => m.tools || []);
  assert.equal(parent.children[0].status, "done");
  assert.equal(parent.children[0].output, "hi");
  assert.equal(parent.children[1].status, "running", "the untouched child still runs");
  assert.equal(parent.output, "report", "the parent keeps its own result");
});

test("a sub-agent spawned by a sub-agent nests one level deeper", () => {
  const nested = [
    { event: "tool_start", data: { id: "outer", name: "Agent", status: "running" } },
    { event: "tool_child", data: { id: "inner", name: "Agent", parentToolUseId: "outer", status: "running" } },
    { event: "tool_child", data: { id: "gc1", name: "Bash", parentToolUseId: "inner", status: "running" } },
    { event: "tool_result_child", data: { id: "gc1", output: "hi", status: "done" } },
  ];
  const { messages } = reduceSessionEvents(nested, "claude");
  const [outer] = messages.flatMap((m) => m.tools || []);
  const [inner] = outer.children;
  assert.equal(inner.children.length, 1, "the grandchild's call survives");
  assert.equal(inner.children[0].status, "done", "and its result reaches it");
  assert.equal(inner.children[0].output, "hi");
});

test("a child whose parent is missing is dropped, not floated", () => {
  const { messages } = reduceSessionEvents(
    [{ event: "tool_child", data: { id: "orphan", parentToolUseId: "gone" } }],
    "claude"
  );
  assert.deepEqual(messages.flatMap((m) => m.tools || []), []);
});

test("a child is not counted twice when the CLI re-sends its start", () => {
  const { messages } = reduceSessionEvents(
    [...log, { event: "tool_child", data: { id: "c1", name: "Bash", parentToolUseId: "p1" } }],
    "claude"
  );
  const [parent] = messages.flatMap((m) => m.tools || []);
  assert.equal(parent.children.length, 2);
});

test("a tool whose result never arrived stops spinning when the turn ends", () => {
  // Recorded: codex emits item.started for a spawn_agent that then fails and is
  // retried under a new id — no item.completed for the first. That row used to spin
  // forever, through the next turn and every reload of the log.
  const { messages } = reduceSessionEvents(
    [
      { event: "tool_start", data: { id: "orphan", name: "spawn_agent", status: "running" } },
      { event: "turn_complete", data: { stats: {} } },
    ],
    "codex"
  );
  const [tool] = messages.flatMap((m) => m.tools || []);
  assert.equal(tool.status, "done");
});

test("the sweep reaches a tool row left in an earlier segment", () => {
  // A tool row stays in the segment it was announced in; text that arrives afterwards
  // opens a new one. Settling only the last message leaves the row spinning.
  const log = [
    { event: "tool_start", data: { id: "x", name: "spawn_agent", status: "running" } },
    { event: "delta", data: { text: "still working" } },
    { event: "turn_complete", data: { stats: {} } },
  ];
  const { messages } = reduceSessionEvents(log, "codex");
  const tools = messages.flatMap((m) => m.tools || []);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, "done");
});

test("a turn still in flight keeps its running tool spinning", () => {
  const { messages } = reduceSessionEvents(
    [{ event: "tool_start", data: { id: "live", name: "Bash", status: "running" } }],
    "claude"
  );
  assert.equal(messages.flatMap((m) => m.tools || [])[0].status, "running");
});

test("reads the shell id out of a background spawn result", () => {
  const out = "Command running in background with ID: b367hw0hy. Output is being written to: /tmp/x.output.";
  assert.equal(shellIdFromResult(out), "b367hw0hy");
  assert.equal(shellIdFromResult("hi\n[exited with code 0]"), "");
  assert.equal(shellIdFromResult(undefined), "");
});

test("the CLI's real background output does not name a shell", () => {
  // A finished BashOutput read must not make the card look like a live shell.
  const out = "<retrieval_status>success</retrieval_status>\n<status>completed</status>\n<output>\nhi\n</output>";
  assert.equal(shellIdFromResult(out), "");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
