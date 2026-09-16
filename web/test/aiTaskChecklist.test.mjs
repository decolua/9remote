// The pinned TASKS strip's read model: the list the pane counts and draws.
//
// Two doors write it — the live path (useAiSession's socket handlers → aiStore.upsertTask)
// and the replay path (reduceSessionEvents → hydrateSession) — and the strip cannot tell
// which one filled it. Both have to land the same list.
//
// Run: cd web && node --import ./test/loader-alias.mjs test/aiTaskChecklist.test.mjs
import assert from "node:assert/strict";
import { parseEngineTaskEvent, parseEngineTaskResult } from "../features/ai/registry.js";
import { reduceSessionEvents } from "../features/ai/hooks/useAiSession.js";
import { useAiStore } from "../shared/stores/aiStore.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// The real payloads, as Claude Code writes them to a transcript: creates return
// "Task #N created successfully: <subject>", updates return "Updated task #N status".
const create = (id, n, subject) => [
  { seq: 0, event: "tool_start", data: { id, name: "TaskCreate", input: { subject }, status: "running" } },
  { seq: 0, event: "tool_result", data: { id, name: "TaskCreate", output: `Task #${n} created successfully: ${subject}`, error: "", status: "done" } }
];
const update = (id, n, patch) => [
  { seq: 0, event: "tool_start", data: { id, name: "TaskUpdate", input: { taskId: String(n), ...patch }, status: "running" } },
  { seq: 0, event: "tool_result", data: { id, name: "TaskUpdate", output: `Updated task #${n} status`, error: "", status: "done" } }
];

const replay = (events) => {
  useAiStore.setState({ bySession: { s1: { tasks: [] } } });
  const reduced = reduceSessionEvents(events.map((e, i) => ({ ...e, seq: i + 1 })), "claude");
  // The pane's own door: reduce, then hand the result to the store (useAiSession's hydrate).
  useAiStore.getState().hydrateSession("s1", { messages: reduced.messages, tasks: reduced.tasks });
  return useAiStore.getState().bySession.s1.tasks;
};

// The live path, driven the way useAiSession drives it: parse the tool event, upsert.
const live = (events) => {
  useAiStore.setState({ bySession: { s1: { tasks: [] } } });
  for (const e of events) {
    const { data } = e;
    if (e.event === "tool_start") {
      const curr = useAiStore.getState().bySession.s1.tasks || [];
      const t = parseEngineTaskEvent("claude", data.name, data.input, data.id, curr);
      if (t) useAiStore.getState().upsertTask("s1", t);
    } else {
      const t = parseEngineTaskResult("claude", data.name, data.output, data.id);
      if (t) useAiStore.getState().upsertTask("s1", t);
    }
  }
  return useAiStore.getState().bySession.s1.tasks;
};

const subjects = (tasks) => tasks.map((t) => t.subject).sort();

for (const [label, run] of [["replay", replay], ["live", live]]) {
  test(`${label}: a deleted task leaves the checklist`, () => {
    // Setting status to `deleted` permanently removes the task. Left in the list it is
    // counted as pending forever, so the strip reads "1/2" on a chat with one task left.
    const tasks = run([
      ...create("c1", 1, "alpha"),
      ...create("c2", 2, "beta"),
      ...update("u1", 2, { status: "deleted" })
    ]);
    assert.equal(tasks.some((t) => t.status === "deleted"), false, "no deleted row survives");
    assert.deepEqual(subjects(tasks), ["alpha"], "the CLI's own numbering is kept");
  });

  test(`${label}: a task created after a deletion keeps the CLI's numbering`, () => {
    // The CLI numbers from its own counter, so #3 is taken even though only two tasks are
    // listed. A guess of "list length + 1" lands on #2 — a live task — and renames it.
    const tasks = run([
      ...create("c1", 1, "alpha"),
      ...create("c2", 2, "beta"),
      ...create("c3", 3, "gamma"),
      ...update("u1", 2, { status: "deleted" }),
      ...create("c4", 4, "delta")
    ]);
    assert.deepEqual(subjects(tasks), ["alpha", "delta", "gamma"], "no live task was renamed");
    assert.equal(tasks.find((t) => t.subject === "delta").taskId, "4");
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
