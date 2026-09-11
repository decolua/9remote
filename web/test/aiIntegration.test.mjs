// End-to-end integration test for Web AI Session & Components
// Run: node web/test/aiIntegration.test.mjs
import assert from "node:assert/strict";
import { AI_ENGINES, ENGINE_INFO, AI_UI_OPTIONS, SLASH_COMMANDS } from "../features/ai/constants.js";
import { getToolCategory, parseEngineTaskEvent } from "../features/ai/registry.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

console.log("Running Web AI Integration tests...");

await test("ENGINE_INFO exports correct configuration for Claude, Codex, OpenCode", () => {
  assert.equal(ENGINE_INFO.claude.id, "claude");
  assert.equal(ENGINE_INFO.codex.id, "codex");
  assert.equal(ENGINE_INFO.opencode.id, "opencode");

  assert.ok(ENGINE_INFO.claude.label.includes("Claude"));
  assert.ok(ENGINE_INFO.codex.label.includes("Codex"));
  assert.ok(ENGINE_INFO.opencode.label.includes("OpenCode"));
});

await test("AI_UI_OPTIONS contains 3 UI options matching expected structure", () => {
  assert.equal(AI_UI_OPTIONS.length, 3);
  const ids = AI_UI_OPTIONS.map((o) => o.id);
  assert.deepEqual(ids, ["claude-ui", "codex-ui", "opencode-ui"]);
  for (const opt of AI_UI_OPTIONS) {
    assert.equal(opt.isAiUi, true);
    assert.ok(opt.aiEngine);
  }
});

await test("SLASH_COMMANDS has primary developer commands", () => {
  const names = SLASH_COMMANDS.map((c) => c.name);
  assert.ok(names.includes("/clear"));
  assert.ok(names.includes("/compact"));
  assert.ok(names.includes("/cost"));
  assert.ok(names.includes("/context"));
  assert.ok(names.includes("/model"));
});

await test("Simulated AI Event stream parser aggregates deltas and tools", () => {
  const events = [
    { event: "delta", data: { text: "Xin chào, " } },
    { event: "delta", data: { text: "tôi là Claude." } },
    { event: "thinking", data: { text: "Đang đọc file..." } },
    { event: "tool_start", data: { id: "t1", name: "bash", input: "ls -la" } },
    { event: "tool_result", data: { id: "t1", output: "total 4\nfile.txt" } },
    { event: "diff", data: { file: "test.js", patch: "+console.log('hi');" } },
    { event: "permission_request", data: { requestId: "req-1", tool: "bash", input: { command: "rm -rf" } } },
    { event: "turn_complete", data: { stats: { inputTokens: 100, outputTokens: 50 } } }
  ];

  let currentMsg = { content: "", thinking: "", tools: [], diffs: [], permission: null, isLive: true };

  for (const { event, data } of events) {
    if (event === "delta") currentMsg.content += data.text;
    if (event === "thinking") currentMsg.thinking += data.text;
    if (event === "tool_start") currentMsg.tools.push({ ...data, status: "running" });
    if (event === "tool_result") {
      currentMsg.tools = currentMsg.tools.map((t) => t.id === data.id ? { ...t, ...data, status: "done" } : t);
    }
    if (event === "diff") currentMsg.diffs.push(data);
    if (event === "permission_request") currentMsg.permission = data;
    if (event === "turn_complete") currentMsg.isLive = false;
  }

  assert.equal(currentMsg.content, "Xin chào, tôi là Claude.");
  assert.equal(currentMsg.thinking, "Đang đọc file...");
  assert.equal(currentMsg.tools.length, 1);
  assert.equal(currentMsg.tools[0].status, "done");
  assert.equal(currentMsg.tools[0].output, "total 4\nfile.txt");
  assert.equal(currentMsg.diffs.length, 1);
  assert.equal(currentMsg.diffs[0].file, "test.js");
  assert.equal(currentMsg.permission.requestId, "req-1");
  assert.equal(currentMsg.isLive, false);
});

await test("tool map covers every engine's real tool names", () => {
  // Claude names verified against the CLI binary; codex/opencode against theirs.
  assert.equal(getToolCategory("claude", "TodoWrite"), "task");
  assert.equal(getToolCategory("claude", "TaskList"), "task");
  assert.equal(getToolCategory("claude", "MultiEdit"), "diff");
  assert.equal(getToolCategory("claude", "NotebookEdit"), "diff");
  assert.equal(getToolCategory("claude", "BashOutput"), "bash");
  assert.equal(getToolCategory("codex", "command_execution"), "bash");
  assert.equal(getToolCategory("codex", "file_change"), "diff");
  assert.equal(getToolCategory("codex", "todo_list"), "task");
  assert.equal(getToolCategory("opencode", "patch"), "diff");
  assert.equal(getToolCategory("opencode", "todowrite"), "task");
  assert.equal(getToolCategory("opencode", "task"), "agent");
});

await test("TodoWrite-style events replace the whole task list", () => {
  for (const [engine, name] of [["claude", "TodoWrite"], ["opencode", "todowrite"], ["codex", "todo_list"]]) {
    const ev = parseEngineTaskEvent(engine, name, { todos: [{ content: "a", status: "completed" }, { content: "  " }] }, "t1", []);
    assert.equal(ev.replaceAll, true);
    assert.equal(ev.todos.length, 1, `${engine}: blank todo should be dropped`);
    assert.equal(ev.todos[0].subject, "a");
    assert.equal(ev.todos[0].status, "completed");
  }
  // Incremental tools still upsert one item at a time
  assert.equal(parseEngineTaskEvent("claude", "TaskCreate", { subject: "z" }, "t2", []).replaceAll, undefined);
});

if (fail > 0) {
  console.error(`\nTests failed: ${fail}/${pass + fail}`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed: ${pass}/${pass}`);
}
