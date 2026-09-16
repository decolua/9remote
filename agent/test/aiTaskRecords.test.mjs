// The harness's task records, carried BESIDE the replay window rather than inside it.
//
// The bug this exists for: a sub-agent or background shell is announced at the top of a
// turn, the turn streams past a 32KB replay window, and an F5 comes back with an empty
// agent strip while the work is still going. Measured on a real 2560-event log, the
// window held 56 events and zero task records.
//
// AiSession.taskRecords is asserted here without constructing a session: it reads
// `history` and nothing else, so a plain object stands in.
//
// Run: node agent/test/aiTaskRecords.test.mjs
import assert from "node:assert/strict";
import { AiSession } from "../features/ai/aiSession.js";
import { AI_TASK_RECORDS_BYTES } from "../features/ai/constants.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// taskRecords touches only `history`; borrow the method rather than build a session,
// which would spawn a CLI.
const withHistory = (history) => AiSession.prototype.taskRecords.call({ history });

const started = (id, extra = {}) => ({
  seq: 0, event: "cli_event",
  data: { type: "system", subtype: "task_started", record: { task_id: id, status: "running", ...extra } }
});
const plain = (event, data) => ({ seq: 0, event, data });

test("task records come out whole, under the harness's own names", () => {
  const recs = withHistory([started("t-1", { tool_use_id: "c1", is_backgrounded: true, description: "build" })]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].type, "system");
  assert.equal(recs[0].subtype, "task_started");
  assert.equal(recs[0].record.task_id, "t-1");
  assert.equal(recs[0].record.is_backgrounded, true);
});

test("a record the pane draws from the log is not carried again", () => {
  // The transcript DOES hold these (an api_error, an edited file). Carrying them here as
  // well would draw each row twice on a rebuild.
  const recs = withHistory([
    plain("cli_event", { type: "system", subtype: "api_error", record: { message: "boom" } }),
    plain("delta", { text: "hi" }),
    plain("user_message", { text: "hey" }),
    started("t-1")
  ]);
  assert.deepEqual(recs.map((r) => r.subtype), ["task_started"]);
});

test("all four task subtypes travel, not just the announcement", () => {
  // The end matters as much as the start: without it the pane draws a task that finished
  // while it was away as still running.
  const recs = withHistory([
    started("t-1"),
    plain("cli_event", { type: "system", subtype: "task_updated", record: { task_id: "t-1", patch: { status: "completed" } } }),
    plain("cli_event", { type: "system", subtype: "task_notification", record: { task_id: "t-1", status: "completed" } }),
    plain("cli_event", { type: "system", subtype: "background_tasks_changed", record: { tasks: [] } })
  ]);
  assert.deepEqual(recs.map((r) => r.subtype),
    ["task_started", "task_updated", "task_notification", "background_tasks_changed"]);
});

test("order is preserved, so the pane folds them in the order they happened", () => {
  const recs = withHistory([
    started("a"),
    started("b"),
    plain("cli_event", { type: "system", subtype: "task_notification", record: { task_id: "a", status: "completed" } })
  ]);
  assert.deepEqual(recs.map((r) => r.record.task_id), ["a", "b", "a"]);
});

test("an empty log carries nothing rather than throwing", () => {
  assert.deepEqual(withHistory([]), []);
});

test("the carried set is bounded, so it cannot push the ack past one SCTP message", () => {
  // Records ride in the SAME frame as the replay window. Unbounded, a long chat's task
  // history (40KB measured on a real session) added to a window that may widen to 48KB
  // would pass the 64KB cap — and one byte over is a frame the wire throws away, which
  // reads as a chat stuck on "Syncing…".
  const filler = "x".repeat(600);
  const history = [];
  for (let i = 0; i < 100; i++) history.push(started(`t-${i}`, { description: filler }));
  const recs = withHistory(history);
  const bytes = JSON.stringify(recs).length;
  assert.ok(bytes <= AI_TASK_RECORDS_BYTES, `carried ${bytes}B, budget ${AI_TASK_RECORDS_BYTES}B`);
  assert.ok(recs.length > 0, "the budget must not be so tight that nothing travels");
  // Newest first is what gets kept: the strip needs the recent ones, not turn 1's.
  assert.equal(recs[recs.length - 1].record.task_id, "t-99");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
