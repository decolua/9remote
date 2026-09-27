// The Jarvis coordinator's kanban board — the pure action reducer. The agent holds
// the board (single source of truth for every surface: MCP tools, socket handlers,
// the web UI mirror), so the rules for create/move/update/delete live here alone.
//
// Run: node agent/test/jarvisKanban.test.mjs
import assert from "node:assert/strict";
import { emptyBoard, applyKanbanAction, syncFleetCards, KANBAN_STATUSES } from "../features/jarvis/jarvisKanban.js";

let pass = 0, fail = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const run = async () => {
  for (const { name, fn } of cases) {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};

console.log("Running jarvis kanban tests...");

test("statuses are exactly the four columns the UI renders", () => {
  assert.deepEqual([...KANBAN_STATUSES], ["todo", "in_progress", "needs_input", "done"]);
});

test("create mints an id, defaults to todo, and keeps the full task", () => {
  const { board, error } = applyKanbanAction(emptyBoard(), {
    type: "create",
    title: "Viết API đăng nhập",
    sessionId: "s-101",
    branch: "feat/auth"
  });
  assert.equal(error, undefined);
  const tasks = Object.values(board.tasks);
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.equal(task.title, "Viết API đăng nhập");
  assert.equal(task.status, "todo");
  assert.equal(task.sessionId, "s-101");
  assert.equal(task.branch, "feat/auth");
  assert.ok(task.id, "an id was minted");
  assert.ok(task.createdAt > 0 && task.updatedAt >= task.createdAt);
});

test("create without a title is refused, not silently kept", () => {
  const { error } = applyKanbanAction(emptyBoard(), { type: "create" });
  assert.ok(error, "a missing title must error");
});

test("move changes status and stamps updatedAt", async () => {
  let { board } = applyKanbanAction(emptyBoard(), { type: "create", title: "T1" });
  const id = Object.keys(board.tasks)[0];
  const before = board.tasks[id].updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const res = applyKanbanAction(board, { type: "move", taskId: id, status: "in_progress" });
  assert.equal(res.error, undefined);
  assert.equal(res.board.tasks[id].status, "in_progress");
  assert.ok(res.board.tasks[id].updatedAt > before, "updatedAt moved");
});

test("move to an unknown column is refused", () => {
  let { board } = applyKanbanAction(emptyBoard(), { type: "create", title: "T1" });
  const id = Object.keys(board.tasks)[0];
  const res = applyKanbanAction(board, { type: "move", taskId: id, status: "archived" });
  assert.ok(res.error);
  assert.equal(res.board.tasks[id].status, "todo", "the board is unchanged");
});

test("move of an unknown task is refused", () => {
  const res = applyKanbanAction(emptyBoard(), { type: "move", taskId: "ghost", status: "done" });
  assert.ok(res.error);
});

test("update patches only the given fields", () => {
  let { board } = applyKanbanAction(emptyBoard(), { type: "create", title: "T1", notes: "a" });
  const id = Object.keys(board.tasks)[0];
  const res = applyKanbanAction(board, { type: "update", taskId: id, patch: { notes: "b", summary: "xong" } });
  assert.equal(res.error, undefined);
  assert.equal(res.board.tasks[id].notes, "b");
  assert.equal(res.board.tasks[id].summary, "xong");
  assert.equal(res.board.tasks[id].title, "T1", "untouched fields survive");
});

test("delete removes the task", () => {
  let { board } = applyKanbanAction(emptyBoard(), { type: "create", title: "T1" });
  const id = Object.keys(board.tasks)[0];
  const res = applyKanbanAction(board, { type: "delete", taskId: id });
  assert.equal(res.error, undefined);
  assert.equal(Object.keys(res.board.tasks).length, 0);
});

test("the input board is never mutated — every action returns a new board", () => {
  const board = emptyBoard();
  const created = applyKanbanAction(board, { type: "create", title: "T1" });
  assert.equal(Object.keys(board.tasks).length, 0, "the original stayed empty");
  assert.equal(Object.keys(created.board.tasks).length, 1);
});

test("an unknown action type is refused", () => {
  const res = applyKanbanAction(emptyBoard(), { type: "explode" });
  assert.ok(res.error);
});

test("a board with junk tasks still answers emptyBoard-shaped queries", () => {
  const board = { tasks: { t1: { id: "t1", title: "x", status: "done" } } };
  const res = applyKanbanAction(board, { type: "move", taskId: "t1", status: "todo" });
  assert.equal(res.error, undefined);
  assert.equal(res.board.tasks.t1.status, "todo");
});

test("a running session appears as an auto card in in_progress", () => {
  const { board, changed } = syncFleetCards(emptyBoard(), [
    { sessionId: "s-1", title: "Backend", engine: "claude", branch: "feat/auth", status: "running", question: null }
  ]);
  assert.equal(changed, true);
  const card = board.tasks["fleet-s-1"];
  assert.ok(card, "the auto card exists");
  assert.equal(card.auto, true);
  assert.equal(card.status, "in_progress");
  assert.equal(card.title, "Backend");
  assert.equal(card.engine, "claude");
});

test("an idle session parks in todo, a gate parks in needs_input with the ask", () => {
  const { board } = syncFleetCards(emptyBoard(), [
    { sessionId: "s-1", title: "A", engine: "bash", status: "idle", question: null },
    { sessionId: "s-2", title: "B", engine: "codex", status: "needs_input", question: "Bash: rm -rf cache?" }
  ]);
  assert.equal(board.tasks["fleet-s-1"].status, "todo");
  assert.equal(board.tasks["fleet-s-2"].status, "needs_input");
  assert.equal(board.tasks["fleet-s-2"].question, "Bash: rm -rf cache?");
});

test("a status change moves the auto card; an unchanged fleet reports no change", () => {
  const first = syncFleetCards(emptyBoard(), [{ sessionId: "s-1", title: "A", status: "running" }]).board;
  const second = syncFleetCards(first, [{ sessionId: "s-1", title: "A", status: "idle" }]);
  assert.equal(second.changed, true);
  assert.equal(second.board.tasks["fleet-s-1"].status, "todo");
  const third = syncFleetCards(second.board, [{ sessionId: "s-1", title: "A", status: "idle" }]);
  assert.equal(third.changed, false, "nothing moved, nothing rewritten");
});

test("a closed session's auto card is swept away", () => {
  const seeded = syncFleetCards(emptyBoard(), [{ sessionId: "s-1", title: "A", status: "running" }]).board;
  const { board, changed } = syncFleetCards(seeded, []);
  assert.equal(changed, true);
  assert.equal(board.tasks["fleet-s-1"], undefined);
});

test("manual tasks are never swept nor renamed by the fleet sync", () => {
  let board = applyKanbanAction(emptyBoard(), { type: "create", title: "Viết API" }).board;
  const res = syncFleetCards(board, [{ sessionId: "s-1", title: "A", status: "running" }]);
  const manual = Object.values(res.board.tasks).find((t) => t.title === "Viết API");
  assert.ok(manual, "the manual task survived");
  assert.equal(manual.auto, undefined);
  const swept = syncFleetCards(res.board, []);
  assert.ok(swept.board.tasks[manual.id], "a manual task outlives every session");
});

test("a needs_input card clears its ask once the gate is answered", () => {
  const seeded = syncFleetCards(emptyBoard(), [{ sessionId: "s-1", title: "A", status: "needs_input", question: "Q?" }]).board;
  const next = syncFleetCards(seeded, [{ sessionId: "s-1", title: "A", status: "running", question: null }]);
  assert.equal(next.board.tasks["fleet-s-1"].question, "");
});

test("report creates the worker's auto card when none exists yet", () => {
  const { board, error } = applyKanbanAction(emptyBoard(), { type: "report", sessionId: "s-9", summary: "xong API" , status: "done" });
  assert.equal(error, undefined);
  const card = board.tasks["fleet-s-9"];
  assert.ok(card?.auto);
  assert.equal(card.summary, "xong API");
  assert.equal(card.status, "done");
  assert.equal(card.reportedStatus, "done");
});

test("report patches an existing auto card and never touches its title", () => {
  const seeded = syncFleetCards(emptyBoard(), [{ sessionId: "s-9", title: "Real Name", engine: "claude", status: "idle" }]).board;
  const { board } = applyKanbanAction(seeded, { type: "report", sessionId: "s-9", summary: "đã fix lint" });
  const card = board.tasks["fleet-s-9"];
  assert.equal(card.title, "Real Name");
  assert.equal(card.summary, "đã fix lint");
  assert.equal(card.reportedStatus, undefined);
});

test("report with a bad status changes nothing", () => {
  const { board, error } = applyKanbanAction(emptyBoard(), { type: "report", sessionId: "s-9", summary: "x", status: "wat" });
  assert.ok(error);
  assert.equal(Object.keys(board.tasks).length, 0);
});

test("sync never clobbers a worker's summary — the gate ask lives in its own field", () => {
  let board = syncFleetCards(emptyBoard(), [{ sessionId: "s-7", title: "W", engine: "claude", status: "idle" }]).board;
  board = applyKanbanAction(board, { type: "report", sessionId: "s-7", summary: "viết xong service layer" }).board;
  board = syncFleetCards(board, [{ sessionId: "s-7", title: "W", engine: "claude", status: "needs_input", question: "Bash: npm test" }]).board;
  const gated = board.tasks["fleet-s-7"];
  assert.equal(gated.summary, "viết xong service layer", "worker's report survives the gate");
  assert.equal(gated.question, "Bash: npm test");
  board = syncFleetCards(board, [{ sessionId: "s-7", title: "W", engine: "claude", status: "idle" }]).board;
  assert.equal(board.tasks["fleet-s-7"].question, "", "ask cleared with the gate");
  assert.equal(board.tasks["fleet-s-7"].summary, "viết xong service layer", "report still there");
});

test("an idle session's self-report decides its column", () => {
  let board = applyKanbanAction(emptyBoard(), { type: "report", sessionId: "s-8", summary: "xong", status: "done" }).board;
  board = syncFleetCards(board, [{ sessionId: "s-8", title: "Bash tab", engine: "bash", status: "idle" }]).board;
  assert.equal(board.tasks["fleet-s-8"].status, "done");
  // A live turn outranks the self-report.
  board = syncFleetCards(board, [{ sessionId: "s-8", title: "Bash tab", engine: "claude", status: "running" }]).board;
  assert.equal(board.tasks["fleet-s-8"].status, "in_progress");
});

test("fleet rows carry their workspace onto the auto card", () => {
  const { board } = syncFleetCards(emptyBoard(), [
    { sessionId: "s-1", title: "9R Term", engine: "bash", status: "running", workspacePath: "/Users/Working/9remote" },
    { sessionId: "s-2", title: "Other", engine: "bash", status: "running", workspacePath: "/other/proj" }
  ]);
  assert.equal(board.tasks["fleet-s-1"].workspace, "/Users/Working/9remote");
  assert.equal(board.tasks["fleet-s-2"].workspace, "/other/proj");
});

test("create stamps the action's workspace onto the task", () => {
  const { board } = applyKanbanAction(emptyBoard(), {
    type: "create", title: "Task test", workspace: "/Users/Working/9remote"
  });
  assert.equal(Object.values(board.tasks)[0].workspace, "/Users/Working/9remote");
});

test("a task without a workspace stays global — visible from every board", () => {
  const { board } = applyKanbanAction(emptyBoard(), { type: "create", title: "Global" });
  assert.equal(Object.values(board.tasks)[0].workspace, null);
});

await run();
