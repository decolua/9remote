// The pane's half of the harness's task model — and the whole of it.
//
// One function reads the CLI's records. There is no per-engine translation and no second
// copy in the store, because a copied model is a model that drifts: the host forwards
// `task_id`, `is_backgrounded`, `output_file` exactly as the CLI wrote them, and this is
// the only place that decides what they mean.
//
// Run: cd web && node --import ./test/loader-alias.mjs test/aiHarnessTasks.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyTaskRecord, runningTasks } from "../features/ai/lib/harnessTasks.js";
import { reduceSessionEvents } from "../features/ai/hooks/useAiSession.js";
import { useAiStore } from "../shared/stores/aiStore.js";
import { runningAsync } from "../features/ai/lib/toolTree.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// Feed a list of [subtype, record] the way the host delivers them.
const feed = (records) =>
  records.reduce((tasks, [subtype, record]) => applyTaskRecord(tasks, "system", subtype, record), []);

// ── the records the CLI actually writes ──

test("a background shell's task_started is read as the CLI wrote it", () => {
  const tasks = feed([["task_started", {
    type: "system", subtype: "task_started", task_id: "bny62e391",
    tool_use_id: "call_lr987rf2", description: "Sleep 15 seconds",
    is_backgrounded: true, task_type: "local_bash"
  }]]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, "bny62e391");
  assert.equal(tasks[0].toolUseId, "call_lr987rf2");
  assert.equal(tasks[0].status, "running");
  assert.equal(tasks[0].background, true);
  assert.equal(tasks[0].taskType, "local_bash");
});

test("a sub-agent's task is told apart by the field the CLI uses", () => {
  const tasks = feed([["task_started", {
    type: "system", subtype: "task_started", task_id: "a74d7c02", tool_use_id: "call_pj23",
    description: "Answer 2+2", subagent_type: "general-purpose", prompt: "what is 2+2?"
  }]]);
  assert.equal(tasks[0].background, false, "no is_backgrounded means not background work");
  assert.equal(tasks[0].subagentType, "general-purpose");
});

test("task_updated merges the patch, under the CLI's own field names", () => {
  const tasks = feed([
    ["task_started", { type: "system", subtype: "task_started", task_id: "t-1", is_backgrounded: true }],
    ["task_updated", { type: "system", subtype: "task_updated", task_id: "t-1", patch: { status: "paused", description: "still going" } }]
  ]);
  assert.equal(tasks[0].status, "paused");
  assert.equal(tasks[0].description, "still going");
});

test("task_notification ends it with the status the CLI gave", () => {
  const tasks = feed([
    ["task_started", { type: "system", subtype: "task_started", task_id: "t-1", is_backgrounded: true }],
    ["task_notification", {
      type: "system", subtype: "task_notification", task_id: "t-1", status: "stopped",
      output_file: "/tmp/tasks/t-1.output", summary: "Sleep 15 seconds"
    }]
  ]);
  assert.equal(tasks[0].status, "stopped");
  assert.equal(tasks[0].outputFile, "/tmp/tasks/t-1.output");
});

test("a finished sub-agent keeps the usage the CLI reported", () => {
  const tasks = feed([
    ["task_started", { type: "system", subtype: "task_started", task_id: "a-1", subagent_type: "Explore" }],
    ["task_notification", {
      type: "system", subtype: "task_notification", task_id: "a-1", status: "completed",
      usage: { total_tokens: 1200, tool_uses: 2, duration_ms: 3400 }
    }]
  ]);
  assert.equal(tasks[0].status, "completed");
  assert.equal(tasks[0].usage.total_tokens, 1200, "kept under the CLI's names, not renamed");
});

test("a stopped task is not flattened into a completed one", () => {
  const tasks = feed([
    ["task_started", { type: "system", subtype: "task_started", task_id: "t-1", is_backgrounded: true }],
    ["task_notification", { type: "system", subtype: "task_notification", task_id: "t-1", status: "stopped" }]
  ]);
  assert.equal(tasks[0].status, "stopped");
});

test("background_tasks_changed settles what it stops listing, and spares sub-agents", () => {
  const tasks = feed([
    ["task_started", { type: "system", subtype: "task_started", task_id: "shell-1", is_backgrounded: true }],
    ["task_started", { type: "system", subtype: "task_started", task_id: "agent-1", subagent_type: "Explore" }],
    ["background_tasks_changed", { type: "system", subtype: "background_tasks_changed", tasks: [] }]
  ]);
  const byId = Object.fromEntries(tasks.map((t) => [t.taskId, t]));
  assert.equal(byId["shell-1"].status, "stopped", "a background task the CLI no longer lists ended");
  assert.equal(byId["agent-1"].status, "running", "a sub-agent is never in that list");
});

test("the live set adds a task the pane never saw start", () => {
  // A client that joins mid-task gets the list, not the history of it.
  const tasks = feed([["background_tasks_changed", {
    type: "system", subtype: "background_tasks_changed",
    tasks: [{ task_id: "t-9", task_type: "local_bash", description: "build" }]
  }]]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, "t-9");
  assert.equal(tasks[0].status, "running");
  assert.equal(tasks[0].background, true);
});

// ── what the strip reads ──

test("only running tasks reach the strip", () => {
  const tasks = feed([
    ["task_started", { type: "system", subtype: "task_started", task_id: "a", is_backgrounded: true }],
    ["task_started", { type: "system", subtype: "task_started", task_id: "b", subagent_type: "Explore" }],
    ["task_notification", { type: "system", subtype: "task_notification", task_id: "a", status: "completed" }]
  ]);
  assert.deepEqual(runningTasks(tasks).map((t) => t.taskId), ["b"]);
});

// ── the rules that keep it cheap ──

test("an unchanged re-announcement returns the same array", () => {
  // The strip is derived on every streamed token; a fresh array each time re-renders it.
  const once = feed([["task_started", { type: "system", subtype: "task_started", task_id: "t-1", description: "x" }]]);
  const twice = applyTaskRecord(once, "system", "task_started", {
    type: "system", subtype: "task_started", task_id: "t-1", description: "x"
  });
  assert.equal(twice, once, "same reference");
});

test("a record for an unknown task is ignored, not invented", () => {
  const tasks = feed([["task_updated", { type: "system", subtype: "task_updated", task_id: "ghost", patch: { status: "completed" } }]]);
  assert.deepEqual(tasks, []);
});

test("a record that is not a system task is left alone", () => {
  const tasks = applyTaskRecord([], "assistant", "", { task_id: "x" });
  assert.deepEqual(tasks, []);
});

test("a malformed record does not throw", () => {
  for (const [subtype, record] of [
    ["task_started", {}], ["task_started", null],
    ["task_updated", { patch: null }], ["task_notification", {}],
    ["background_tasks_changed", {}], ["something_new", { task_id: "x" }]
  ]) {
    assert.doesNotThrow(() => applyTaskRecord([], "system", subtype, record), `${subtype} must not throw`);
  }
});


// ── one reader, two doors ──


// The host delivers the CLI's records as `cli_event`, so both doors see the same thing.
const asLog = (records) => records.map(([subtype, record], i) => ({
  seq: i + 1, event: "cli_event", data: { type: "system", subtype, record }
}));

const RECORDS = [
  ["task_started", { type: "system", subtype: "task_started", task_id: "shell-1", tool_use_id: "c1", description: "build", is_backgrounded: true }],
  ["task_started", { type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: "c2", subagent_type: "Explore" }],
  ["task_updated", { type: "system", subtype: "task_updated", task_id: "shell-1", patch: { status: "paused" } }],
  ["background_tasks_changed", { type: "system", subtype: "background_tasks_changed", tasks: [] }],
  ["task_notification", { type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" }]
];

test("the replay door folds the records into the task list", () => {
  const out = reduceSessionEvents(asLog(RECORDS), "claude");
  const byId = Object.fromEntries(out.harnessTasks.map((t) => [t.taskId, t]));
  assert.equal(byId["shell-1"].status, "stopped");
  assert.equal(byId["agent-1"].status, "completed");
});

test("the live door lands exactly what the replay door does", () => {
  useAiStore.getState().initSession("parity");
  for (const [type, subtype, record] of asLog(RECORDS).map((e) => [e.data.type, e.data.subtype, e.data.record])) {
    useAiStore.getState().applyTaskRecords("parity", [[type, subtype, record]]);
  }
  const live = useAiStore.getState().bySession["parity"].harnessTasks;
  const replay = reduceSessionEvents(asLog(RECORDS), "claude").harnessTasks;
  assert.deepEqual(live, replay, "two doors, one reader — they must not drift");
});

test("a record the reader does not model is still carried through the replay", () => {
  const out = reduceSessionEvents(asLog([["api_retry", { type: "system", subtype: "api_retry", attempt: 2 }]]), "claude");
  assert.equal(out.harnessRecords.length, 1);
  assert.equal(out.harnessRecords[0][2].attempt, 2);
});


// ── the strip reads the harness's task set, not a guess ──


test("a task the CLI says is running is what the strip shows", () => {
  const rows = runningAsync([], [
    { taskId: "shell-1", toolUseId: "c1", status: "running", background: true, description: "build" },
    { taskId: "agent-1", toolUseId: "c2", status: "completed", background: false, description: "look" }
  ]);
  assert.deepEqual(rows, [{ kind: "shell", id: "c1", label: "build" }],
    "the CLI's status decides, not a row that was handed off");
});

test("with no task set the row scan still answers, for engines that keep no model", () => {
  // codex and antigravity hand work off and never name it again — their row IS the model.
  const messages = [{ tools: [{ id: "call_x", name: "Agent", status: "running", async: true, input: { description: "look" } }] }];
  assert.deepEqual(runningAsync(messages, []), [{ kind: "agent", id: "call_x", label: "look" }]);
});


// ── the replay door speaks the same vocabulary as the live door ──

test("the transcript reader emits the CLI's own record, not a name of its own", () => {
  // The two doors must agree on what a task record LOOKS like. The reader in
  // agent/features/ai/claudeTranscript.js rebuilds a task's end from the
  // `<task-notification>` a transcript keeps, and the pane folds records with ONE reader
  // (lib/harnessTasks.js). A name only one side knows is a task that vanishes on reopen
  // with nothing on screen to say it was ever there — which is what this catches.
  const src = readFileSync(new URL("../../agent/features/ai/claudeTranscript.js", import.meta.url), "utf8");
  assert.match(src, /subtype: "task_notification"/, "the replay must emit the harness's own subtype");
  assert.doesNotMatch(src, /event: "task_done"/, "not a name invented for the replay");
});

test("the reader that folds records knows every subtype the host can send", () => {
  // The host forwards these four live, and the transcript reader rebuilds one of them.
  const shapes = ["task_started", "task_updated", "task_notification", "background_tasks_changed"];
  for (const subtype of shapes) {
    const next = applyTaskRecord([], "system", subtype, { type: "system", subtype, task_id: "t-1" });
    assert.ok(Array.isArray(next), `${subtype} must be handled`);
  }
  // And a subtype from another engine's vocabulary must not be mistaken for one.
  assert.deepEqual(applyTaskRecord([], "system", "item.started", { item: {} }), []);
});


// ── the replay door speaks the same vocabulary as the live door ──


// ── the hydrate door: the replay's own rebuild must reach the store ──

test("hydrateSession takes the harness's task list, or the strip blanks on F5", () => {
  // The reducer rebuilds `harnessTasks` from the replayed records, and the hydrate door
  // is what carries it into the store. Dropping it left the strip with a fresh-but-empty
  // list while a shell was still running — the pane showed nothing pinned after a reload.
  useAiStore.getState().initSession("hyd");
  useAiStore.getState().hydrateSession("hyd", {
    messages: [],
    harnessTasks: [{ taskId: "t-1", status: "running", background: true, description: "build" }]
  });
  assert.equal(useAiStore.getState().bySession["hyd"].harnessTasks.length, 1);
});

test("the reducer's rebuilt list is what a hydrate hands over", () => {
  const out = reduceSessionEvents(asLog([
    ["task_started", { type: "system", subtype: "task_started", task_id: "t-1", is_backgrounded: true, description: "build" }]
  ]), "claude");
  assert.equal(out.harnessTasks.length, 1, "the reducer rebuilds it");
  assert.equal(out.harnessTasks[0].taskId, "t-1");
});

test("the live set does not blank a description it did not carry", () => {
  // `background_tasks_changed` lists tasks WITHOUT their description in practice — the
  // record the CLI writes for a shell carries task_id/task_type only. Overwriting with
  // that emptied the label the strip shows, so a running shell lost its name the moment
  // the live set was republished.
  let t = [];
  t = applyTaskRecord(t, "system", "task_started", { task_id: "t-1", description: "build the thing", is_backgrounded: true });
  t = applyTaskRecord(t, "system", "background_tasks_changed", { tasks: [{ task_id: "t-1", task_type: "local_bash" }] });
  assert.equal(t[0].description, "build the thing", "a field the record did not carry is left as it was");
  assert.equal(t[0].status, "running");
});

test("the live set still refreshes a field it does carry", () => {
  let t = [];
  t = applyTaskRecord(t, "system", "task_started", { task_id: "t-1", description: "old", is_backgrounded: true });
  t = applyTaskRecord(t, "system", "background_tasks_changed", { tasks: [{ task_id: "t-1", description: "new", task_type: "local_bash" }] });
  assert.equal(t[0].description, "new");
});

test("a re-announced task keeps the name the CLI gave it earlier", () => {
  // The CLI announces a task more than once, and not every announcement carries every
  // field. Writing the blanks over what an earlier one said is how a sub-agent lost the
  // type that labels it.
  let t = [];
  t = applyTaskRecord(t, "system", "task_started", { task_id: "a-1", description: "look it up", subagent_type: "Explore" });
  t = applyTaskRecord(t, "system", "task_started", { task_id: "a-1", description: "look it up" });
  assert.equal(t[0].subagentType, "Explore", "the type survives an announcement without it");
  assert.equal(t[0].description, "look it up");
});

test("a task that resumes drops the end it reported before", () => {
  // `end_time` rides a patch for a task that STOPPED. If the CLI later moves that task
  // back to a live status, the stamp is no longer true — keeping it prints "ended at …"
  // over work that is running.
  let t = [];
  t = applyTaskRecord(t, "system", "task_started", { task_id: "t-1", is_backgrounded: true });
  t = applyTaskRecord(t, "system", "task_updated", { task_id: "t-1", patch: { status: "killed", end_time: 123 } });
  assert.equal(t[0].endedAt, 123, "the end it reported is kept");
  t = applyTaskRecord(t, "system", "task_updated", { task_id: "t-1", patch: { status: "running" } });
  assert.equal(t[0].status, "running");
  assert.equal("endedAt" in t[0], false, "no stale end on a task that is running again");
});

test("a paused task carries no end stamp either", () => {
  // Paused is not running and not over. An end stamp there would read as "finished".
  let t = [];
  t = applyTaskRecord(t, "system", "task_started", { task_id: "t-1", is_backgrounded: true });
  t = applyTaskRecord(t, "system", "task_updated", { task_id: "t-1", patch: { status: "paused" } });
  assert.equal(t[0].status, "paused");
  assert.equal("endedAt" in t[0], false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
