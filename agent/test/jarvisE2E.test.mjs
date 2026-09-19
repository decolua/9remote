// End-to-end over the real socket handlers: run whole coordination turns through
// the conductor's tool doors, and watch the fleet report it. Only two edges are
// faked, both beyond this process by nature: the daemon KV (an in-memory stand-in)
// and the worker CLIs (sessions planted into the real globalAiManager).
//
// Run: node agent/test/jarvisE2E.test.mjs
import assert from "node:assert/strict";
import { makeCreateSessionTool } from "../mcp/tools/jarvis/index.js";
import { setupJarvisHandlers } from "../features/jarvis/jarvisSocket.js";
import { globalAiManager } from "../features/ai/aiManager.js";
import { resetAgentForTests, setAgentConfig } from "../features/jarvis/jarvisAgent.js";
import { resetBoardCache, loadBoard, applyAndBroadcast, foldFleetIntoBoard, setBoardKvForTests } from "../features/jarvis/jarvisState.js";

// The board rides the daemon's KV in production; tests get an in-memory one so
// they never touch a live machine's board. Cloned on the way out like real IPC.
const kvStore = new Map();
setBoardKvForTests({
  get: async (key) => (kvStore.has(key) ? structuredClone(kvStore.get(key)) : null),
  set: async (key, value) => { kvStore.set(key, structuredClone(value)); }
});

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

// One socket for every door: fresh handlers each time, exactly like a connect.
const freshSocket = () => {
  const handlers = {};
  setupJarvisHandlers({ on: (event, handler) => { handlers[event] = handler; } });
  return handlers;
};
const call = (handlers, event, payload = {}) =>
  new Promise((resolve) => handlers[event](payload, resolve));
const callJarvis = async (name, args) => {
  const res = await call(freshSocket(), "jarvis:tool", { name, args });
  return { isError: !res?.ok, text: res?.ok ? res.result : res?.error };
};
// The BASE MCP door a worker CLI talks to (report_task lives there, not in the
// conductor's set).
const callMcp = async (name, args, sessionId) => {
  const { handleRpc } = await import("../mcp/mcpServer.js");
  const res = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { sessionId });
  return { isError: res.result.isError, text: res.result.content[0].text };
};

// The worker the conductor will drive: a planted AiSession stand-in. Real shape —
// sendPrompt, pendingPermission, resolvePermission/Question, isTurnRunning — so
// every real code path here (fleet runner, dispatch, gate) exercises the same API.
let workerState;
const plantWorker = (id, engine, cwd) => {
  workerState = { prompts: [], resolved: [], gate: null, running: false };
  const session = {
    id, engine, cwd, lastPrompt: "",
    get isTurnRunning() { return workerState.running; },
    pendingPermission: () => workerState.gate,
    resolvePermission(requestId, behavior, message) {
      workerState.resolved.push({ kind: "permission", requestId, behavior, message });
      workerState.gate = null;
      return true;
    },
    resolveQuestion(requestId, answers) {
      workerState.resolved.push({ kind: "question", requestId, answers });
      workerState.gate = null;
      return true;
    },
    sendPrompt(prompt) {
      workerState.prompts.push(prompt);
      this.lastPrompt = prompt;
      workerState.running = true;
      return true;
    }
  };
  globalAiManager.sessions.set(id, session);
  return session;
};

console.log("Running jarvis coordinator E2E...");

test("the conductor plans the work on the board over the tool door", async () => {
  resetBoardCache();
  const created = await callJarvis("manage_kanban", { type: "create", title: "Viết API đăng nhập", sessionId: "s-101", branch: "feat/auth" });
  assert.equal(created.isError, false);
  const board = JSON.parse(created.text);
  const task = Object.values(board.tasks)[0];
  assert.equal(task.status, "todo");
  assert.equal(task.sessionId, "s-101");
});

test("the board tracks the assignment, the fleet sees the worker running", async () => {
  plantWorker("s-101", "claude", "/proj/backend");
  // Find the real task from the previous step and move it to in_progress
  const board = await loadBoard();
  const taskId = Object.keys(board.tasks).find((id) => board.tasks[id].title === "Viết API đăng nhập");
  const moved = await callJarvis("manage_kanban", { type: "move", taskId, status: "in_progress" });
  assert.equal(JSON.parse(moved.text).tasks[taskId].status, "in_progress");

  const dispatched = await callJarvis("dispatch_prompt", { sessionId: "s-101", prompt: "viết API đăng nhập, xong báo lại" });
  assert.equal(dispatched.isError, false, JSON.stringify(dispatched));
  assert.deepEqual(workerState.prompts, ["viết API đăng nhập, xong báo lại"]);

  const fleet = JSON.parse((await callJarvis("list_fleet", {})).text);
  const row = fleet.find((r) => r.sessionId === "s-101");
  assert.equal(row.status, "running");
  assert.equal(row.engine, "claude");
});

test("the worker hits a gate — the fleet reports needs_input with the ask", async () => {
  workerState.gate = { requestId: "req-77", tool: "Bash", input: { command: "npm test" } };
  const fleet = JSON.parse((await callJarvis("list_fleet", {})).text);
  const row = fleet.find((r) => r.sessionId === "s-101");
  assert.equal(row.status, "needs_input");
  assert.match(row.question, /Bash/);
});

test("the conductor relays the user's decision and the worker is released", async () => {
  const res = await callJarvis("resolve_gate", { sessionId: "s-101", requestId: "req-77", decision: "allow" });
  assert.equal(res.isError, false, JSON.stringify(res));
  assert.deepEqual(workerState.resolved, [{ kind: "permission", requestId: "req-77", behavior: "allow", message: "" }]);

  const fleet = JSON.parse((await callJarvis("list_fleet", {})).text);
  assert.equal(fleet.find((r) => r.sessionId === "s-101").status, "running");
});

test("the conductor closes the card and the socket state agrees with the tools", async () => {
  workerState.running = false;
  const board0 = await loadBoard();
  const taskId = Object.keys(board0.tasks).find((id) => board0.tasks[id].title === "Viết API đăng nhập");
  const done = await callJarvis("manage_kanban", { type: "move", taskId, status: "done" });
  assert.equal(JSON.parse(done.text).tasks[taskId].status, "done");

  // The web side reads the same board through its own door.
  const handlers = {};
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  setupJarvisHandlers(socket);
  const state = await new Promise((resolve) => handlers["jarvis:getState"]({}, resolve));
  assert.equal(state.ok, true);
  assert.equal(state.board.tasks[taskId].status, "done");
  assert.ok(state.fleet.some((r) => r.sessionId === "s-101"), "fleet rides along in the same state");
});

test("a hand move through the socket door lands on the same board", async () => {
  const handlers = {};
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  setupJarvisHandlers(socket);
  const board0 = await new Promise((resolve) => handlers["jarvis:getState"]({}, resolve));
  const taskId = Object.keys(board0.board.tasks).find((id) => board0.board.tasks[id].title === "Viết API đăng nhập");
  const res = await new Promise((resolve) => handlers["jarvis:kanban"]({ action: { type: "delete", taskId } }, resolve));
  assert.equal(res.ok, true);
  assert.equal(res.board.tasks[taskId], undefined);
});

test("getState folds the fleet into auto cards — an open session is never missing from the board", async () => {
  resetBoardCache();
  plantWorker("s-301", "claude", "/proj/x");
  const handlers = {};
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  setupJarvisHandlers(socket);
  const state = await new Promise((resolve) => handlers["jarvis:getState"]({}, resolve));
  const card = state.board.tasks["fleet-s-301"];
  assert.ok(card, "the session has its auto card");
  assert.equal(card.auto, true);
  assert.equal(card.engine, "claude");
  // The planted worker starts idle (no turn sent) → parks in todo.
  assert.equal(card.status, "todo");

  // A second read after the session "closes" sweeps the card.
  globalAiManager.sessions.delete("s-301");
  const after = await new Promise((resolve) => handlers["jarvis:getState"]({}, resolve));
  assert.equal(after.board.tasks["fleet-s-301"], undefined, "closed session's card swept");
});

test("concurrent board actions lose no update — one door, one queue", async () => {
  // Two doors race: a tool call and a user hand move, both aimed at the same
  // board. Without single-flight each reads the same old board and one write
  // erases the other; the queue must land both cards.
  resetBoardCache();
  const [a, b] = await Promise.all([
    applyAndBroadcast({ type: "create", title: "Race A" }),
    applyAndBroadcast({ type: "create", title: "Race B" })
  ]);
  assert.equal(a.error, undefined);
  assert.equal(b.error, undefined);
  const titles = Object.values((await loadBoard()).tasks).map((t) => t.title);
  assert.ok(titles.includes("Race A"), "A survived the race");
  assert.ok(titles.includes("Race B"), "B survived the race");
});

test("a report racing a getState fold is not erased by its save", async () => {
  resetBoardCache();
  // Before the fold joined the write queue, getState loaded, a report wrote, and
  // the fold's save overwrote it — the report vanished. Serialized, both land.
  const [folded, reported] = await Promise.all([
    foldFleetIntoBoard([{ sessionId: "s-501", title: "W", engine: "bash", status: "idle" }]),
    callMcp("report_task", { summary: "báo giữa fold" }, "s-501")
  ]);
  assert.equal(reported.isError, false, JSON.stringify(reported));
  const board = await loadBoard();
  assert.ok(board.tasks["fleet-s-501"], "fold's card exists");
  assert.equal(board.tasks["fleet-s-501"].summary, "báo giữa fold");
});

test("the live voice door: manifest + tool runs over the agent socket", async () => {
  resetBoardCache();
  const handlers = {};
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  setupJarvisHandlers(socket);

  const manifest = await new Promise((resolve) => handlers["jarvis:tools"]({}, resolve));
  assert.equal(manifest.ok, true);
  assert.equal(manifest.tools.length, 7, "the conductor's seven, same instances as MCP");

  const made = await new Promise((resolve) => handlers["jarvis:tool"]({ name: "manage_kanban", args: { type: "create", title: "Live giao việc" } }, resolve));
  assert.equal(made.ok, true);
  assert.ok(Object.values((await loadBoard()).tasks).some((t) => t.title === "Live giao việc"));

  const bad = await new Promise((resolve) => handlers["jarvis:tool"]({ name: "nope" }, resolve));
  assert.equal(bad.ok, false, "unknown tool is refused");
  const err = await new Promise((resolve) => handlers["jarvis:tool"]({ name: "manage_kanban", args: { type: "wat" } }, resolve));
  assert.equal(err.ok, false, "a tool's own error surfaces, not a throw");
});

test("create_session with fake daemon deps still shapes the full flow", async () => {
  const typed = [];
  const tool = makeCreateSessionTool({
    createPtySession: async ({ name, cwd }) => ({ success: true, sessionId: "s-202", cwd }),
    registerManagedSession: () => {},
    sendInput: (sessionId, data) => typed.push([sessionId, data])
  });
  const res = await tool.run({ engine: "claude", cwd: "/proj/web", title: "Frontend" }, {});
  assert.equal(res.sessionId, "s-202");
  assert.deepEqual(typed, [["s-202", "claude\n"]]);
});

test("a failed board read surfaces an error — it must not poison writes into a wipe", async () => {
  resetBoardCache();
  await applyAndBroadcast({ type: "create", title: "Giữ tôi" }, "test");
  // One read failure: the action must fail loudly, not silently fall back to an
  // empty board whose next save would erase everything.
  const snapshot = new Map(kvStore);
  setBoardKvForTests({
    get: async () => { throw new Error("daemon hiccup"); },
    set: async () => { throw new Error("must not save on a failed read"); }
  });
  resetBoardCache();
  let rejected = false;
  try { await applyAndBroadcast({ type: "create", title: "Không nên thấy" }, "test"); }
  catch { rejected = true; }
  assert.ok(rejected, "the action rejects instead of wiping");
  await new Promise((r) => setTimeout(r, 10));
  // Restore — the data from before the failure is still exactly there.
  kvStore.clear();
  for (const [k, v] of snapshot) kvStore.set(k, structuredClone(v));
  setBoardKvForTests({
    get: async (key) => (kvStore.has(key) ? structuredClone(kvStore.get(key)) : null),
    set: async (key, value) => { kvStore.set(key, structuredClone(value)); }
  });
  resetBoardCache();
  const board = await loadBoard();
  assert.ok(Object.values(board.tasks).some((t) => t.title === "Giữ tôi"), "the pre-failure task survived");
  assert.equal(Object.values(board.tasks).some((t) => t.title === "Không nên thấy"), false);
});

test("a worker reports its own line over JSON-RPC — the board keeps it, live state wins", async () => {
  resetBoardCache();
  plantWorker("s-404", "claude", "/proj/r");
  workerState.running = false;
  const res = await callMcp("report_task", { summary: "API đăng nhập xong, 12 test xanh", status: "done" }, "s-404");
  assert.equal(res.isError, false, JSON.stringify(res));

  const board = await loadBoard();
  const card = board.tasks["fleet-s-404"];
  assert.ok(card, "the worker's auto card exists");
  assert.equal(card.summary, "API đăng nhập xong, 12 test xanh");
  assert.equal(card.status, "done");

  // The turn starts: the live signal outranks the self-report, the report survives.
  workerState.running = true;
  const handlers = {};
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  setupJarvisHandlers(socket);
  const state = await new Promise((resolve) => handlers["jarvis:getState"]({}, resolve));
  const after = state.board.tasks["fleet-s-404"];
  assert.equal(after.status, "in_progress", "running outranks the self-report");
  assert.equal(after.summary, "API đăng nhập xong, 12 test xanh", "the report survives the fold");
});

await run();
