// Every engine's records reach the pane — not just Claude's.
//
// Claude got this first: a record no branch claimed travels whole as `cli_event` instead of
// falling through the last `if` into silence. Measured before this file existed: a record
// no adapter recognised produced ZERO events on all three other engines — the same silent
// hole Claude had, where 33 of 39 record shapes were being dropped.
//
// Why this matters more than it looks: the pane is a re-render of each CLI's own TUI, so
// its vocabulary is supposed to BE that CLI's. A record the adapter silently eats is one
// the pane can never draw, and nobody finds out — there is no error, no log, no missing
// pixel. It is just less than the CLI said.
//
// What this test CANNOT prove, said plainly: Claude's sweep walks the SDK's own
// SDKMessage union (39 shapes, from sdk.d.ts). Codex, OpenCode and Antigravity ship no
// such type definitions, so there is no list to walk. This proves the necessary half —
// an unknown record is carried rather than lost — not the sufficient one.
//
// Run: node agent/test/engineEventCoverage.test.mjs
import assert from "node:assert/strict";
import { CodexAdapter } from "../features/ai/adapters/codexAdapter.js";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";
import { AntigravityAdapter } from "../features/ai/adapters/antigravityAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

/** Feed one record and report every event the adapter emitted. */
function emitWith(Adapter, record) {
  const events = [];
  const adapter = new Adapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  adapter.handleEvent(record);
  return events;
}

// A record no branch of any adapter knows. Deliberately shaped like a real one — engines
// add fields to records they already send, and a new `type` alongside them.
const UNKNOWN = {
  codex: { type: "thread.something_new", thread_id: "t-1", payload: { detail: "future" } },
  opencode: { type: "session.something_new", properties: { sessionID: "s-1" } },
  antigravity: { event: "something_new", detail: "future" }
};

test("codex: a record no branch claims is carried, not dropped", () => {
  const events = emitWith(CodexAdapter, UNKNOWN.codex);
  const carried = events.filter(([e]) => e === "cli_event");
  assert.equal(carried.length, 1, "an unknown record must reach the pane");
  assert.equal(carried[0][1].type, "thread.something_new", "under its own name");
  assert.equal(carried[0][1].record.thread_id, "t-1", "and whole");
});

test("opencode: a record no branch claims is carried, not dropped", () => {
  const events = emitWith(OpenCodeAdapter, UNKNOWN.opencode);
  const carried = events.filter(([e]) => e === "cli_event");
  assert.equal(carried.length, 1);
  assert.equal(carried[0][1].type, "session.something_new");
  assert.equal(carried[0][1].record.properties.sessionID, "s-1");
});

test("antigravity: a record no branch claims is carried, not dropped", () => {
  const events = emitWith(AntigravityAdapter, UNKNOWN.antigravity);
  const carried = events.filter(([e]) => e === "cli_event");
  assert.equal(carried.length, 1);
  assert.equal(carried[0][1].type, "something_new", "the name it carries");
  assert.equal(carried[0][1].record.detail, "future", "and the record whole");
});

// ── and a record a branch DOES claim is not sent twice ──
//
// The passthrough must be a LAST resort. Firing it alongside the normal branch would draw
// every known record twice: once as its card, once as a raw line.

test("codex: a record a branch handles is not also passed through", () => {
  const events = emitWith(CodexAdapter, { type: "item.started", item: { id: "i1", type: "command_execution", command: "ls" } });
  assert.ok(events.length > 0, "the branch ran");
  assert.equal(events.filter(([e]) => e === "cli_event").length, 0, "and nothing was passed through on top");
});

test("opencode: a record a branch handles is not also passed through", () => {
  // The shape this adapter parses is flat: `type` on the record itself (`"text"`,
  // `"tool_use"`, `"step_finish"`). An outer SDK envelope like `message.part.updated` is
  // NOT one it knows — and it is exactly the kind of thing that should be carried.
  const events = emitWith(OpenCodeAdapter, { type: "text", part: { text: "hi" } });
  assert.ok(events.length > 0, "the branch ran");
  assert.equal(events.filter(([e]) => e === "cli_event").length, 0);
});

test("antigravity: a record a branch handles is not also passed through", () => {
  // This CLI names its records with `event` and nests the payload under it — the shape
  // this adapter parses. Anything else is unknown to it, and belongs in the passthrough.
  const events = emitWith(AntigravityAdapter, { event: "step_update", step_update: { step_index: 1, step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: {} } });
  assert.ok(events.length > 0, "the branch ran");
  assert.equal(events.filter(([e]) => e === "cli_event").length, 0);
});

// ── malformed input must not throw ──

test("antigravity: the user's own prompt is the one record deliberately dropped", () => {
  // It is the prompt echoed back, already drawn when it was sent — carrying it would show
  // every prompt twice. Named here so the next reader can tell a decision from an oversight.
  const events = emitWith(AntigravityAdapter, { event: "step_update", step_update: { step_index: 1, step_type: "user_input", text: "hello" } });
  assert.equal(events.length, 0);
});

test("a record with no type at all does not throw", () => {
  for (const A of [CodexAdapter, OpenCodeAdapter, AntigravityAdapter]) {
    assert.doesNotThrow(() => emitWith(A, {}), `${A.name} must survive an empty record`);
    assert.doesNotThrow(() => emitWith(A, { type: null }), `${A.name} must survive a null type`);
  }
});

test("one record produces one carried event, never a stream of them", () => {
  // A passthrough wired into a loop, or fired per field, would multiply every unknown
  // record — a log that grows faster than the CLI talks.
  for (const [A, rec] of [[CodexAdapter, UNKNOWN.codex], [OpenCodeAdapter, UNKNOWN.opencode], [AntigravityAdapter, UNKNOWN.antigravity]]) {
    assert.equal(emitWith(A, rec).filter(([e]) => e === "cli_event").length, 1, `${A.name}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
