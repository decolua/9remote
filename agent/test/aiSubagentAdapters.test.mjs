// Sub-agent UI parity across the non-Claude engines, verified against the real CLIs:
//   codex  — item.type "collab_tool_call" (spawn_agent / wait / …)
//   opencode — tool "task", sub-agent runs in its own session
//   agy    — step_type "subagent", plus PascalCase tool parameters the cards must read
// Run: node agent/test/aiSubagentAdapters.test.mjs
import assert from "node:assert/strict";
import { CodexAdapter } from "../features/ai/adapters/codexAdapter.js";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";
import { AntigravityAdapter } from "../features/ai/adapters/antigravityAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Replays recorded CLI output lines through an adapter and returns what it emitted.
function replay(Adapter, lines, setup = () => {}) {
  const events = [];
  const adapter = new Adapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  setup(adapter);
  for (const line of lines) adapter.handleEvent(JSON.parse(line));
  return { adapter, events, of: (name) => events.filter(([e]) => e === name) };
}

console.log("Running sub-agent adapter parity tests...");

// ── codex ──
const codexItem = (phase, item) => JSON.stringify({ type: phase, item });

test("codex: a spawn_agent call becomes an agent card carrying the brief", () => {
  const { of } = replay(CodexAdapter, [
    codexItem("item.started", {
      id: "item_4", type: "collab_tool_call", tool: "spawn_agent",
      prompt: "Run `ls -la` and report back.", status: "in_progress"
    })
  ]);
  const [start] = of("tool_start");
  assert.equal(start[1].id, "item_4");
  assert.equal(start[1].name, "spawn_agent");
  assert.equal(start[1].input.prompt, "Run `ls -la` and report back.");
  assert.equal(start[1].status, "running");
});

test("codex: an errored agent surfaces as a failure, not a silent done", () => {
  // Recorded: with no credentials the CLI reports the agent errored inside
  // agents_states while the item's own status still reads completed.
  const { of } = replay(CodexAdapter, [
    codexItem("item.completed", {
      id: "item_8", type: "collab_tool_call", tool: "wait", status: "completed",
      agents_states: { "thread-1": { status: "errored", message: "404 No active credentials" } }
    })
  ]);
  const [result] = of("tool_result");
  assert.equal(result[1].status, "error");
  assert.match(result[1].error, /404 No active credentials/);
});

test("codex: a healthy agent completes with no error", () => {
  const { of } = replay(CodexAdapter, [
    codexItem("item.completed", {
      id: "item_8", type: "collab_tool_call", tool: "wait", status: "completed",
      agents_states: { "thread-1": { status: "completed", message: null } }
    })
  ]);
  assert.equal(of("tool_result")[0][1].status, "done");
  // Both keys always, empty on the other side — the ONE wire shape every door now sends
  // (see toolEvent.js), so a card reads the same whichever engine or path wrote it.
  assert.equal(of("tool_result")[0][1].error, "");
});

test("codex: control calls with no brief still announce an id", () => {
  // close_agent/resume_agent carry no prompt; the card still needs an id to attach to.
  const { of } = replay(CodexAdapter, [
    codexItem("item.started", { id: "item_9", type: "collab_tool_call", tool: "close_agent", prompt: null, status: "in_progress" })
  ]);
  assert.equal(of("tool_start")[0][1].name, "close_agent");
  assert.deepEqual(of("tool_start")[0][1].input, {});
});

// The live stream says "this call is done" with the ENVELOPE, not with a field on the
// item — `item.started` then `item.completed`, the item carrying no status of its own.
// The rollout has only the completed record and says it on the item. One shared mapper
// reads both, so the envelope has to be handed over as the status it stands for; without
// that, a replayed item and a live one disagreed and file_change dropped its diff.
test("codex: the live envelope is the status, on every tool type", () => {
  const { of } = replay(CodexAdapter, [
    codexItem("item.started", { id: "t1", type: "command_execution", command: "ls" }),
    codexItem("item.completed", { id: "t1", type: "command_execution", command: "ls", aggregated_output: "a\n" }),
    codexItem("item.started", { id: "t2", type: "file_change", changes: [{ path: "/w/x.txt" }] }),
    codexItem("item.completed", { id: "t2", type: "file_change", changes: { "/w/x.txt": { type: "add", content: "hi\n" } } })
  ]);
  assert.deepEqual(of("tool_start").map(([, d]) => d.id), ["t1", "t1", "t2", "t2"]);
  assert.equal(of("tool_result")[0][1].output, "a\n");
  // The patch only exists on the completed record, and no path means no diff card.
  assert.equal(of("diff")[0][1].patch, "+hi");
  assert.equal(of("tool_result")[1][1].status, "done");
});

// The live stream names a changed file `file_change`; the rollout names it `FileChange`.
// A gate written on one literal matched the rollout and missed the live stream, so the
// adapter read no patch and the card came out empty — the pane showed "Running or no
// output returned…" where a diff used to be. The role decides, so both spellings must
// reach the same end: a patch card and a done row.
test("codex: a live file_change draws its diff in either spelling", () => {
  for (const spelling of ["file_change", "FileChange"]) {
    const out = [];
    const adapter = new CodexAdapter({ cwd: "/tmp", onEvent: (e, d) => out.push([e, d]) });
    // No rollout on disk for this cwd, so the patch has to come from the item itself —
    // which is the case that regressed.
    adapter.handleEvent({
      type: "item.completed",
      item: { id: "i1", type: spelling, changes: { "/w/a.txt": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new\n" } } }
    });
    const diff = out.find(([e]) => e === "diff");
    assert.ok(diff, `${spelling}: expected a diff card, got ${JSON.stringify(out.map(([e]) => e))}`);
    assert.equal(diff[1].file, "/w/a.txt");
    assert.equal(diff[1].patch, "@@ -1 +1 @@\n-old\n+new\n");
    assert.equal(out.find(([e]) => e === "tool_result")?.[1].status, "done");
  }
});

// ── opencode ──
test("opencode: a task call becomes an agent card with its brief", () => {
  const { of } = replay(OpenCodeAdapter, [
    JSON.stringify({
      type: "tool_use",
      part: {
        tool: "task", callID: "call_1c01",
        state: {
          status: "completed",
          input: { description: "Run ls -la", prompt: "Run the command ls -la", subagent_type: "general" },
          output: "<task_result>done</task_result>"
        }
      }
    })
  ]);
  const [start] = of("tool_start");
  assert.equal(start[1].name, "task");
  assert.equal(start[1].input.subagent_type, "general");
  assert.equal(start[1].input.prompt, "Run the command ls -la");
  assert.equal(of("tool_result")[0][1].status, "done");
});

// ── antigravity ──
const agyStep = (o) => JSON.stringify({ event: "step_update", step_update: o });

test("agy: a subagent step becomes an agent card with role and brief", () => {
  const { of } = replay(AntigravityAdapter, [
    agyStep({
      step_index: 2, state: "ACTIVE", step_type: "subagent", tool_name: "invoke_subagent",
      subagent_info: { subagents: [{ type_name: "self", role: "Command Runner", initial_prompt: "Please run ls -la" }] }
    }),
    agyStep({ step_index: 2, state: "DONE", step_type: "subagent", tool_name: "invoke_subagent" })
  ]);
  const [start] = of("tool_start");
  assert.equal(start[1].name, "invoke_subagent");
  assert.equal(start[1].input.subagent_type, "Command Runner");
  assert.equal(start[1].input.prompt, "Please run ls -la");
  // Start and result must share the id or the result is dropped.
  assert.equal(of("tool_result")[0][1].id, start[1].id);
});

// NOT recorded from a real run — no agy session ever emitted this state (see the
// adapter). The test pins the handling so a failure could never be settled as success.
test("agy: a failed subagent reports an error, not a settle-to-done", () => {
  const { of } = replay(AntigravityAdapter, [
    agyStep({ step_index: 2, state: "ACTIVE", step_type: "subagent", tool_name: "invoke_subagent", subagent_info: { subagents: [{ role: "R", initial_prompt: "x" }] } }),
    agyStep({ step_index: 2, state: "ERROR", step_type: "subagent", tool_name: "invoke_subagent", subagent_info: { error: { message: "subagent crashed" } } })
  ]);
  const [result] = of("tool_result");
  assert.equal(result[1].status, "error");
  assert.equal(result[1].error, "subagent crashed");
  assert.equal(result[1].id, of("tool_start")[0][1].id, "result must attach to the start");
});

test("agy: PascalCase parameters are mapped to the shape the cards read", () => {
  // Verified against agy 1.2.1. Unmapped, a Bash row showed its bare tool name and
  // the command was neither displayed nor copyable.
  const { of } = replay(AntigravityAdapter, [
    agyStep({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls -la ." } } }),
    agyStep({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { parameters: { AbsolutePath: "/tmp/a.txt" } } }),
    agyStep({ step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/tmp/b.txt" } } }),
    agyStep({ step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "grep_search", tool_info: { parameters: { Query: "hi", SearchPath: "/tmp" } } }),
    agyStep({ step_index: 5, state: "ACTIVE", step_type: "tool", tool_name: "list_dir", tool_info: { parameters: { DirectoryPath: "/tmp" } } })
  ]);
  const inputs = of("tool_start").map(([, d]) => d.input);
  assert.equal(inputs[0].command, "ls -la .");
  assert.equal(inputs[1].file_path, "/tmp/a.txt");
  assert.equal(inputs[2].file_path, "/tmp/b.txt");
  assert.equal(inputs[3].query, "hi");
  assert.equal(inputs[3].path, "/tmp");
  assert.equal(inputs[4].path, "/tmp");
});

test("agy: an unmapped parameter key is passed through, not dropped", () => {
  const { of } = replay(AntigravityAdapter, [
    agyStep({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "some_new_tool", tool_info: { parameters: { Whatever: "x" } } })
  ]);
  assert.equal(of("tool_start")[0][1].input.Whatever, "x");
});

// Codex runs every built-in through one shell tool, so a read, a search and a patch all
// arrived as a row reading "command" — a whole session of reads was indistinguishable
// from the commands around it. `parsed_cmd` is the CLI's own tag for what the command
// was; the row is named from it. Recorded shapes, one per tag.
test("codex: a tagged command is named for what it did, not for the shell", () => {
  const { of } = replay(CodexAdapter, [
    codexItem("item.completed", {
      id: "c1", type: "command_execution", command: ["/bin/bash", "-lc", "cat a.js | head -n 100"],
      parsed_cmd: [{ type: "read", cmd: "cat a.js", name: "a.js", path: "web/a.js" }],
      aggregated_output: "…", exit_code: 0
    }),
    codexItem("item.completed", {
      id: "c2", type: "command_execution", command: ["/bin/bash", "-lc", "find . -name '*chat*'"],
      parsed_cmd: [{ type: "search", cmd: "find . -name '*chat*'", query: "*chat*", path: "." }],
      aggregated_output: "", exit_code: 0
    }),
    codexItem("item.completed", {
      id: "c3", type: "command_execution", command: ["/bin/bash", "-lc", "ls -la"],
      parsed_cmd: [{ type: "list_files", cmd: "ls -la", path: null }],
      aggregated_output: "", exit_code: 0
    }),
    // Untagged and `unknown` both keep the plain name — the shell is all that is known.
    codexItem("item.completed", {
      id: "c4", type: "command_execution", command: ["/bin/bash", "-lc", "npm test"],
      parsed_cmd: [{ type: "unknown", cmd: "npm test" }], aggregated_output: "", exit_code: 0
    }),
    codexItem("item.completed", { id: "c5", type: "command_execution", command: ["/bin/bash", "-lc", "pwd"], aggregated_output: "", exit_code: 0 })
  ]);
  const starts = of("tool_start").map(([, d]) => d);
  assert.deepEqual(starts.map((d) => d.name), ["read", "search", "list_files", "command", "command"]);
  // The row prints what the CLI ran, not the login shell it ran it through: codex hands
  // the unwrapped line over on `parsed_cmd[].cmd`, which is the same on every OS
  // (`-lc` on POSIX, `-Command` on PowerShell, `/d /s /c` on cmd) so nothing here has to
  // know which one it is. A compound call keeps both commands.
  assert.equal(starts[0].input.command, "cat a.js");
  assert.equal(starts[1].input.command, "find . -name '*chat*'");
  assert.equal(starts[3].input.command, "npm test");
  // No parsed_cmd at all (the live stream drops it): the raw argv is the only thing left.
  assert.equal(starts[4].input.command, "/bin/bash -lc pwd");
  assert.equal(starts[0].input.path, "web/a.js");
  assert.equal(starts[1].input.query, "*chat*");
  // Start and result must agree on the name, or the row is renamed mid-flight.
  assert.deepEqual(of("tool_result").map(([, d]) => d.name), ["read", "search", "list_files", "command", "command"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
