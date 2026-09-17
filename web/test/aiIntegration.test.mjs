// End-to-end integration test for Web AI Session & Components
// Run: node web/test/aiIntegration.test.mjs
import assert from "node:assert/strict";
import { ENGINE_INFO, AI_UI_OPTIONS } from "../features/ai/constants.js";
import { getToolCategory, parseEngineTaskEvent, getEngineConfig, listEngines, listEngineInstances } from "../features/ai/registry.js";
import { splitPath } from "../features/ai/lib/shortenPath.js";

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

await test("AI_UI_OPTIONS is derived from the engines that declare a ui block", () => {
  // The contract, not a count. A hardcoded 3 went red the moment opencode's chat surface
  // was pulled (it declared a `ui` block and no longer does — see the registry's comment
  // on temporary hiding), which said nothing about whether the derivation was right.
  // Derived from the ENGINE INSTANCES' own `ui` blocks — the source `listAiUiOptions`
  // reads. Comparing against `listAiUiOptions()` itself would be the function checking
  // its own answer.
  const declared = listEngineInstances().filter((e) => e.ui).map((e) => e.ui.id);
  assert.deepEqual(AI_UI_OPTIONS.map((o) => o.id), declared);
  assert.ok(AI_UI_OPTIONS.length > 0, "at least one engine exposes a chat UI");
  for (const opt of AI_UI_OPTIONS) {
    assert.equal(opt.isAiUi, true);
    assert.ok(opt.aiEngine, `${opt.id} must name the engine it runs`);
    assert.ok(listEngines().some((e) => e.id === opt.aiEngine), `${opt.aiEngine} must be a registered engine`);
  }
  // The two that are live today, named so a silent removal is not just a shorter array.
  assert.ok(AI_UI_OPTIONS.some((o) => o.id === "claude-ui"));
  assert.ok(AI_UI_OPTIONS.some((o) => o.id === "codex-ui"));
});

await test("each engine exposes slash commands through its resolved config", () => {
  // The canonical source is the registry — constants no longer exports a flat list.
  const claude = getEngineConfig("claude").slashCommands.map((c) => c.name);
  assert.ok(claude.includes("/clear"));
  assert.ok(claude.includes("/compact"));
  assert.ok(claude.includes("/cost"));
  assert.ok(claude.includes("/context"));
  assert.ok(claude.includes("/model"));

  for (const engine of listEngines()) {
    const cmds = getEngineConfig(engine.id).slashCommands;
    assert.ok(cmds.length > 0, `${engine.id} has no slash commands`);
    // Every entry must declare what picking it does, or the composer cannot route it.
    for (const c of cmds) assert.ok(c.action, `${engine.id} ${c.name} has no action`);
  }
});

await test("splitPath trims the workspace prefix and separates the name", () => {
  const ws = "/Users/Working/9remote";
  assert.deepEqual(splitPath(`${ws}/web/features/ai/registry.js`, ws), {
    dir: "web/features/ai",
    name: "registry.js"
  });
  // A bare file name has no directory part
  assert.deepEqual(splitPath(`${ws}/package.json`, ws), { dir: "", name: "package.json" });
  // Outside the workspace the tail is kept and the dropped front is marked
  const outside = splitPath("/Users/other/project/a/b/c/deep/file.js", ws);
  assert.equal(outside.name, "file.js");
  assert.ok(outside.dir.startsWith("…"), outside.dir);
  // Whatever happens, the name is never truncated — that is what the UI relies on.
  assert.equal(splitPath("/a/very/deeply/nested/path/that/keeps/going/important.js", "").name, "important.js");
  assert.deepEqual(splitPath("", ws), { dir: "", name: "" });
  assert.deepEqual(splitPath(null, ws), { dir: "", name: "" });
  // Windows separators normalize before comparing
  assert.deepEqual(splitPath("C:\\repo\\src\\a.js", "C:\\repo"), { dir: "src", name: "a.js" });
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
  // Every name in the server's own `CollabAgentTool` union draws as an agent, not as the
  // generic card: four of the nine used to fall through, so an agent being steered
  // mid-flight read as an anonymous tool call.
  for (const name of ["spawn_agent", "send_input", "resume_agent", "wait", "close_agent",
                      "send_message", "followup_task", "interrupt_agent", "list_agents"]) {
    assert.equal(getToolCategory("codex", name), "agent", `codex ${name} is a sub-agent call`);
  }
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
