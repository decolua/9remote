// The web mirror of the Jarvis kanban board. The agent owns the board; this store
// renders it and lets the user act on it — every hand move is optimistic locally
// and relayed to the agent through a sink the view wires to the bus.
//
// Run: node --import ./test/loader-alias.mjs web/test/kanbanStore.test.mjs
import assert from "node:assert/strict";
import { useKanbanStore, columnsOf, visibleTasks } from "../shared/stores/kanbanStore.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running kanban store tests...");

const reset = () => useKanbanStore.setState({ board: { tasks: {} }, sink: null });

test("applyBoard replaces the whole board — the agent's copy is the truth", () => {
  reset();
  useKanbanStore.getState().applyBoard({ tasks: { t1: { id: "t1", title: "A", status: "todo" } } });
  assert.equal(Object.keys(useKanbanStore.getState().board.tasks).length, 1);
  useKanbanStore.getState().applyBoard({ tasks: {} });
  assert.equal(Object.keys(useKanbanStore.getState().board.tasks).length, 0);
});

test("applyBoard tolerates junk — an empty board, not a crash", () => {
  reset();
  useKanbanStore.getState().applyBoard(null);
  assert.deepEqual(useKanbanStore.getState().board, { tasks: {} });
});

test("a hand move updates the card at once and relays the action to the sink", () => {
  reset();
  const relayed = [];
  useKanbanStore.getState().setSink((action) => relayed.push(action));
  useKanbanStore.getState().applyBoard({ tasks: { t1: { id: "t1", title: "A", status: "todo" } } });
  useKanbanStore.getState().moveTask("t1", "done");
  assert.equal(useKanbanStore.getState().board.tasks.t1.status, "done", "optimistic update landed");
  assert.deepEqual(relayed, [{ type: "move", taskId: "t1", status: "done" }]);
});

test("moving an unknown task is a no-op on both sides", () => {
  reset();
  const relayed = [];
  useKanbanStore.getState().setSink((a) => relayed.push(a));
  useKanbanStore.getState().moveTask("ghost", "done");
  assert.equal(relayed.length, 0);
});

test("a hand delete relays and drops the card", () => {
  reset();
  const relayed = [];
  useKanbanStore.getState().setSink((a) => relayed.push(a));
  useKanbanStore.getState().applyBoard({ tasks: { t1: { id: "t1", title: "A", status: "todo" } } });
  useKanbanStore.getState().deleteTask("t1");
  assert.equal(useKanbanStore.getState().board.tasks.t1, undefined);
  assert.deepEqual(relayed, [{ type: "delete", taskId: "t1" }]);
});

test("columnsOf groups tasks by status in board order", () => {
  reset();
  const cols = columnsOf({
    t1: { id: "t1", title: "A", status: "todo" },
    t2: { id: "t2", title: "B", status: "in_progress" },
    t3: { id: "t3", title: "C", status: "todo" }
  });
  assert.deepEqual(cols.todo.map((t) => t.id), ["t1", "t3"]);
  assert.deepEqual(cols.in_progress.map((t) => t.id), ["t2"]);
  assert.deepEqual(cols.needs_input, []);
  assert.deepEqual(cols.done, []);
});

test("columnsOf is pure — the same tasks object yields a stable grouping", () => {
  const tasks = { t1: { id: "t1", title: "A", status: "todo" } };
  const a = columnsOf(tasks);
  const b = columnsOf(tasks);
  assert.deepEqual(a, b);
  assert.deepEqual(tasks, { t1: { id: "t1", title: "A", status: "todo" } }, "input untouched");
});

test("visibleTasks keeps this workspace's cards plus the global ones", () => {
  const tasks = {
    t1: { id: "t1", title: "A", workspace: "/w/9remote" },
    t2: { id: "t2", title: "B", workspace: "/w/other" },
    t3: { id: "t3", title: "C", workspace: null }
  };
  const seen = visibleTasks(tasks, "/w/9remote");
  assert.deepEqual(Object.keys(seen).sort(), ["t1", "t3"]);
  assert.deepEqual(Object.keys(visibleTasks(tasks, "/w/other")).sort(), ["t2", "t3"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
