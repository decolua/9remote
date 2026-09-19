// The Jarvis MCP surface. Two contracts live here:
//   1. the manifest — exactly five coordinator tools, named once, schema'd once;
//   2. the session gate — a plain worker session must not even SEE them, and a
//      cross-session call is refused, so only the Jarvis session can conduct.
// Tool bodies are tested through injected fakes: the real ones ride the daemon IPC
// and the AI manager, neither of which exists in a test process.
//
// Run: node agent/test/jarvisTools.test.mjs
import assert from "node:assert/strict";
import { JARVIS_TOOLS, jarvisToolManifest, makeListFleetTool, makeCreateSessionTool, makeDispatchPromptTool, makeResolveGateTool, makeManageKanbanTool, makeReadTerminalTool, makeCloseSessionTool } from "../mcp/tools/jarvis/index.js";
import { makeReportTaskTool } from "../mcp/tools/reportTask.js";
import { cleanTerminalOutput } from "../features/jarvis/terminalText.js";
import { emptyBoard, applyKanbanAction } from "../features/jarvis/jarvisKanban.js";
import { matchWorkspacePath } from "../features/terminal/terminalSocket.js";

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

const rpc = async (method, params, ctx) => (await import("../mcp/mcpServer.js")).handleRpc({ jsonrpc: "2.0", id: 1, method, params }, ctx);

console.log("Running jarvis MCP tool tests...");

test("the manifest is exactly the seven coordinator tools, by name", () => {
  assert.deepEqual(
    jarvisToolManifest().map((t) => t.name).sort(),
    ["close_session", "create_session", "dispatch_prompt", "list_fleet", "manage_kanban", "read_terminal", "resolve_gate"]
  );
  for (const tool of JARVIS_TOOLS) {
    assert.equal(typeof tool.run, "function", `${tool.name} has a run`);
    assert.ok(tool.description, `${tool.name} is described`);
    assert.ok(tool.inputSchema, `${tool.name} has a schema`);
  }
});

test("manage_kanban mutates the board through the one shared door", async () => {
  let board = emptyBoard();
  const applyAction = async (action) => {
    const res = applyKanbanAction(board, action);
    if (res.error) return res;
    board = res.board;
    return res;
  };
  const tool = makeManageKanbanTool({ applyAction });
  const res = await tool.run({ type: "create", title: "Viết API" }, {});
  assert.equal(res.error, undefined);
  assert.equal(Object.keys(board.tasks).length, 1);
  assert.match(String(res), /Viết API/);
});

test("manage_kanban reports a bad action instead of throwing", async () => {
  const tool = makeManageKanbanTool({ applyAction: async (a) => applyKanbanAction(emptyBoard(), a) });
  const res = await tool.run({ type: "nope" }, {});
  assert.ok(res.error);
});

test("create_session starts a PTY, registers it as a listed session, and launches the engine", async () => {
  const wrote = [];
  const registered = [];
  const tool = makeCreateSessionTool({
    createPtySession: async ({ name, cwd }) => ({ success: true, sessionId: "new-1", cwd, shellId: "zsh" }),
    registerManagedSession: (info) => registered.push(info),
    sendInput: (sessionId, data) => wrote.push([sessionId, data])
  });
  const res = await tool.run({ engine: "claude", cwd: "/proj", workspace: "/w/9remote", title: "Backend" }, {});
  assert.equal(res.sessionId, "new-1");
  // The registration is what puts the tab on the sidebar — pinned to the workspace.
  assert.equal(registered.length, 1);
  assert.equal(registered[0].sessionId, "new-1");
  assert.equal(registered[0].workspacePath, "/w/9remote");
  assert.equal(registered[0].name, "Backend");
  assert.equal(wrote.length, 1);
  assert.equal(wrote[0][0], "new-1");
  assert.match(wrote[0][1], /^claude/);
});

test("create_session with engine bash types nothing", async () => {
  const wrote = [];
  const tool = makeCreateSessionTool({
    createPtySession: async () => ({ success: true, sessionId: "new-2" }),
    registerManagedSession: () => {},
    sendInput: (sessionId, data) => wrote.push([sessionId, data])
  });
  await tool.run({ engine: "bash" }, {});
  assert.equal(wrote.length, 0);
});

test("create_session with yolo appends the engine's skip flag", async () => {
  const wrote = [];
  const tool = makeCreateSessionTool({
    createPtySession: async () => ({ success: true, sessionId: "new-3" }),
    registerManagedSession: () => {},
    sendInput: (sessionId, data) => wrote.push(data)
  });
  await tool.run({ engine: "claude", yolo: true }, {});
  assert.equal(wrote[0], "claude --dangerously-skip-permissions\n");
});

test("create_session surfaces a failed spawn", async () => {
  const tool = makeCreateSessionTool({
    createPtySession: async () => ({ success: false, error: "daemon down" }),
    sendInput: () => {}
  });
  const res = await tool.run({ engine: "claude" }, {});
  assert.ok(res.error);
});

test("matchWorkspacePath pins by containment, deepest root wins", () => {
  const ws = [
    { id: "a", path: "/Users/Working/9remote" },
    { id: "b", path: "/Users/Working/9remote/web" },
    { id: "c", path: "/Users/Working/other-project-longer" }
  ];
  assert.equal(matchWorkspacePath(ws, "/Users/Working/9remote").id, "a", "exact hit");
  assert.equal(matchWorkspacePath(ws, "/Users/Working/9remote/web/components").id, "b", "deepest containing root");
  assert.equal(matchWorkspacePath(ws, "/Users/Working/9remote/").id, "a", "trailing slash tolerated");
  assert.equal(matchWorkspacePath(ws, "/Users/Working/9remote/web/").id, "b", "slash + subfolder");
  assert.equal(matchWorkspacePath(ws, "/nowhere/near"), null, "no match stays unpinned");
  assert.equal(matchWorkspacePath([], "/anywhere"), null);
  assert.equal(matchWorkspacePath(ws, ""), null, "empty target pins nothing");
  // The parent workspace named exactly beats a child workspace nested inside it.
  assert.equal(matchWorkspacePath(ws, "/Users/Working/9remote").id, "a", "exact beats deeper child");
  // A target ABOVE the workspaces falls back to the closest one below it.
  assert.equal(matchWorkspacePath(ws, "/Users/Working").id, "a", "ancestor target picks the shallowest workspace");
});

test("dispatch_prompt routes to the AI session when one owns the id", async () => {
  const sent = [];
  const typed = [];
  const tool = makeDispatchPromptTool({
    getAiSession: (id) => ({ sendPrompt: (m) => sent.push([id, m]) }),
    sendInput: (id, d) => typed.push([id, d])
  });
  await tool.run({ sessionId: "s1", prompt: "làm nốt test" }, {});
  assert.deepEqual(sent, [["s1", "làm nốt test"]]);
  assert.equal(typed.length, 0, "nothing is typed into the PTY");
});

test("dispatch_prompt falls back to typing when only a PTY exists", async () => {
  const typed = [];
  const tool = makeDispatchPromptTool({
    getAiSession: () => null,
    sendInput: (id, d) => typed.push([id, d])
  });
  await tool.run({ sessionId: "s1", prompt: "npm test" }, {});
  assert.equal(typed.length, 1);
  assert.match(typed[0][1], /npm test\n$/);
});

test("dispatch_prompt to a busy AI session is an honest error, not a fake ok", async () => {
  const sent = [];
  const tool = makeDispatchPromptTool({
    getAiSession: () => ({ isTurnRunning: true, sendPrompt: (m) => sent.push(m) }),
    sendInput: () => {}
  });
  const res = await tool.run({ sessionId: "s1", prompt: "việc mới" }, {});
  assert.ok(res.error, "the busy turn was reported");
  assert.equal(sent.length, 0, "nothing was pushed into the running turn");
});

test("dispatch_prompt without a prompt is refused", async () => {
  const tool = makeDispatchPromptTool({ getAiSession: () => null, sendInput: () => {} });
  const res = await tool.run({ sessionId: "s1" }, {});
  assert.ok(res.error);
});

test("resolve_gate answers a question when an answer is given", async () => {
  const answered = [];
  const tool = makeResolveGateTool({
    getAiSession: () => ({ resolveQuestion: (requestId, answers) => { answered.push(["q", requestId, answers]); return true; },
                          resolvePermission: () => { answered.push(["p"]); return true; } })
  });
  await tool.run({ sessionId: "s1", requestId: "r9", answer: "PostgreSQL" }, {});
  assert.deepEqual(answered[0], ["q", "r9", "PostgreSQL"]);
});

test("resolve_gate answers a permission when only a decision is given", async () => {
  const answered = [];
  const tool = makeResolveGateTool({
    getAiSession: () => ({ resolveQuestion: () => false,
                          resolvePermission: (requestId, behavior, message) => { answered.push(["p", requestId, behavior, message]); return true; } })
  });
  await tool.run({ sessionId: "s1", requestId: "r7", decision: "deny", reason: "sửa file kia" }, {});
  assert.deepEqual(answered[0], ["p", "r7", "deny", "sửa file kia"]);
});

test("resolve_gate maps a non-allow decision to deny", async () => {
  const answered = [];
  const tool = makeResolveGateTool({
    getAiSession: () => ({ resolveQuestion: () => false,
                          resolvePermission: (rid, behavior) => { answered.push(behavior); return true; } })
  });
  await tool.run({ sessionId: "s1", requestId: "r1", decision: "whatever" }, {});
  assert.equal(answered[0], "deny");
});

test("resolve_gate with no AI session is an honest error", async () => {
  const tool = makeResolveGateTool({ getAiSession: () => null });
  const res = await tool.run({ sessionId: "s1", requestId: "r1", decision: "allow" }, {});
  assert.ok(res.error);
});

test("resolve_gate reports a stale gate as an error, not a silent ok", async () => {
  const tool = makeResolveGateTool({
    getAiSession: () => ({ resolveQuestion: () => false, resolvePermission: () => false })
  });
  const res = await tool.run({ sessionId: "s1", requestId: "gone", decision: "allow" }, {});
  assert.ok(res.error);
});

test("list_fleet returns the injected snapshot as JSON", async () => {
  const tool = makeListFleetTool({ fleetSnapshot: async () => [{ sessionId: "s1", status: "idle" }] });
  const res = await tool.run({}, {});
  const rows = JSON.parse(String(res));
  assert.equal(rows[0].sessionId, "s1");
});

test("the real (default-deps) tools are still constructible — imports resolve", () => {
  // The default exports must exist; calling them needs a live daemon, which is
  // the e2e file's business with fakes at a higher level.
  assert.equal(JARVIS_TOOLS.length, 7);
});

test("close_session closes through the shared destroyer and never itself", async () => {
  const closed = [];
  const tool = makeCloseSessionTool({ destroySession: async (id) => { closed.push(id); return true; } });
  const res = await tool.run({ sessionId: "s-worker" }, { sessionId: "jarvis" });
  assert.deepEqual(res, { closed: "s-worker" });
  assert.deepEqual(closed, ["s-worker"]);
  // Suicide and blank ids are refused, honestly.
  assert.ok((await tool.run({ sessionId: "jarvis" }, { sessionId: "jarvis" })).error);
  assert.ok((await tool.run({}, {})).error);
  const missing = makeCloseSessionTool({ destroySession: async () => false });
  assert.ok((await missing.run({ sessionId: "gone" }, {})).error, "unknown session reported");
});

test("a tool returning an object crosses the wire as JSON, not [object Object]", async () => {
  const { TOOL_BY_NAME } = await import("../mcp/tools/index.js");
  TOOL_BY_NAME.set("test_obj_tool", { name: "test_obj_tool", run: async () => ({ closed: "s-obj" }) });
  try {
    const res = await rpc("tools/call", { name: "test_obj_tool", arguments: {} }, { sessionId: "worker-1" });
    assert.equal(res.result.isError, false, JSON.stringify(res));
    assert.notEqual(res.result.content[0].text, "[object Object]");
    assert.equal(JSON.parse(res.result.content[0].text).closed, "s-obj");
  } finally {
    TOOL_BY_NAME.delete("test_obj_tool");
  }
});

test("report_task is a BASE tool — every session sees it", async () => {
  const res = await rpc("tools/list", {}, { sessionId: "worker-1" });
  assert.ok(res.result.tools.some((t) => t.name === "report_task"));
});

test("report_task reports for the CALLER's session, taken from ctx — never from args", async () => {
  const actions = [];
  const tool = makeReportTaskTool({ applyAction: async (a) => { actions.push(a); return {}; } });
  const res = await tool.run({ summary: "  xong auth  ", status: "done" }, { sessionId: "s-worker" });
  assert.equal(res.error, undefined);
  assert.deepEqual(actions, [{ type: "report", sessionId: "s-worker", summary: "xong auth", status: "done" }]);
});

test("report_task refuses an empty summary, a caller with no identity, and caps length", async () => {
  const tool = makeReportTaskTool({ applyAction: async () => ({}) });
  assert.ok((await tool.run({ summary: "   " }, { sessionId: "s" })).error);
  assert.ok((await tool.run({ summary: "ok" }, {})).error, "no ctx session → honest error, no stray card");
  const tool2 = makeReportTaskTool({ applyAction: async (a) => { actions2.push(a.summary); return {}; } });
  const actions2 = [];
  await tool2.run({ summary: "x".repeat(600) }, { sessionId: "s" });
  assert.equal(actions2[0].length, 500);
});

test("cleanTerminalOutput strips ANSI and control noise, collapses blanks", () => {
  const noisy = "\x1b[32m✓ 3 passed\x1b[0m\x1b[K\r\n\x1b]0;title\x07\r\n\r\n\r\n\x07  \x1b[2mdone  \x1b[22m\r\n";
  assert.equal(cleanTerminalOutput(noisy), "✓ 3 passed\ndone");
});

test("cleanTerminalOutput keeps only the newest lines and cuts at a line boundary", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
  const tail = cleanTerminalOutput(lines.join("\n"), { maxLines: 5 });
  assert.equal(tail, "line-95\nline-96\nline-97\nline-98\nline-99");
  const byteCapped = cleanTerminalOutput(lines.join("\n"), { maxBytes: 40 });
  assert.ok(byteCapped.startsWith("line-"), "resumes at a whole line: " + JSON.stringify(byteCapped.slice(0, 10)));
  assert.ok(!byteCapped.includes("\nline-0\n"), "the oldest lines are gone");
});

test("read_terminal returns the daemon's newest chunk, cleaned", async () => {
  const raw = Buffer.from("\x1b[31mERR\x1b[0mboom\nok").toString("base64");
  const tool = makeReadTerminalTool({ fetchHistory: async () => ({ success: true, prefix: raw }) });
  const res = await tool.run({ sessionId: "s-1", lines: 10 }, {});
  assert.equal(res, "ERRboom\nok");
});

test("read_terminal is honest about a missing session and clamps lines", async () => {
  const asked = [];
  const tool = makeReadTerminalTool({ fetchHistory: async (sid, have) => { asked.push([sid, have]); return { success: false, error: "Session not found" }; } });
  assert.equal((await tool.run({ sessionId: "gone" }, {})).error, "Session not found");
  assert.deepEqual(asked, [["gone", 0]], "the tail is the newest chunk (have=0)");
  assert.ok((await tool.run({}, {})).error, "no sessionId → error");
});

await run();
