// todo.updated on the v2 bus feeds the task strip: it replays as a synthetic
// todowrite pair so the existing checklist pipeline renders it unchanged.
// Run: node agent/test/opencodeTodo.test.mjs
import assert from "node:assert/strict";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

function makeAdapter() {
  const events = [];
  const adapter = new OpenCodeAdapter({
    cwd: "/tmp",
    onEvent: (e, d) => events.push([e, d]),
    server: {
      listCommands: async () => [], runCommand: async () => ({}), createSession: async () => ({ id: "s" }),
      prompt: async () => {}, setSessionModel: async () => {}, setSessionAgent: async () => {},
      interruptSession: async () => {}, activeSessions: async () => ({}), subscribeBus: () => ({ close() {} }),
    },
  });
  adapter.activeSessionId = "ses_t";
  return { adapter, events, of: (name) => events.filter(([e]) => e === name) };
}

console.log("Running opencode todo event tests...");

test("todo.updated replays as a todowrite pair with mapped statuses", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent({ type: "todo.updated", data: { sessionID: "ses_t", todos: [
    { content: "Write plan", status: "in_progress", priority: "high" },
    { content: "Ship it", status: "completed", priority: "low" }
  ] } });
  const [start] = of("tool_start");
  assert.equal(start[1].name, "todowrite");
  assert.deepEqual(start[1].input.todos, [
    { content: "Write plan", status: "in_progress" },
    { content: "Ship it", status: "completed" }
  ]);
  const [done] = of("tool_result");
  assert.equal(done[1].status, "done");
  assert.equal(done[1].id, start[1].id, "the pair must share one id");
});

test("each todo.updated gets a fresh id", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent({ type: "todo.updated", data: { sessionID: "ses_t", todos: [{ content: "a", status: "pending" }] } });
  adapter.handleEvent({ type: "todo.updated", data: { sessionID: "ses_t", todos: [{ content: "b", status: "pending" }] } });
  const ids = of("tool_start").map(([, d]) => d.id);
  assert.notEqual(ids[0], ids[1]);
});

test("an empty todo list still replaces the strip", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent({ type: "todo.updated", data: { sessionID: "ses_t", todos: [] } });
  assert.deepEqual(of("tool_start")[0][1].input.todos, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
