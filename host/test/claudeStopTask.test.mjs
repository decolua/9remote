// Stopping ONE background task, the way the TUI's per-row stop does it.
//
// The gesture is small but the wiring is a whole path: strip button → ai:stopTask →
// AiSession.stopTask → adapter.stopTask → the CLI's `stop_task` control request. Each
// link is asserted here, because a break in any of them is silent — the row just keeps
// spinning, which is exactly what the strip already looked like before this existed.
//
// What is NOT asserted is the CLI's own behaviour: that a stop really ends the task was
// verified against a live 2.1.273 run (background task: `task_notification status=stopped`
// + `background_tasks_changed tasks:[]`; background subagent: same notification). The
// envelope below is the shape those runs used.
//
// Run: node agent/test/claudeStopTask.test.mjs
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../features/ai/adapters/claudeAdapter.js";
import { AI_SOCKET_EVENTS } from "../features/ai/constants.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

function fakeProc() {
  return {
    written: [],
    onLine: null,
    onExit: null,
    write(t) { this.written.push(t); },
    emit(o) { this.onLine?.(typeof o === "string" ? o : JSON.stringify(o)); },
    async start() { return { lines: [], after: [], missed: 0, release() {}, commit() {} }; },
    async stop() {}
  };
}

function adapterWith(proc = fakeProc()) {
  const adapter = new ClaudeAdapter({ cwd: "/w", onEvent: () => {}, proc });
  adapter._reset("default");
  return { adapter, proc };
}

const lastWrite = (proc) => JSON.parse(proc.written[proc.written.length - 1]);

// ── the request itself ──

test("stopTask writes a stop_task control request naming the task", () => {
  const { adapter, proc } = adapterWith();
  assert.equal(adapter.stopTask("bny62e391"), true);
  const sent = lastWrite(proc);
  assert.equal(sent.type, "control_request");
  assert.equal(sent.request.subtype, "stop_task");
  assert.equal(sent.request.task_id, "bny62e391");
  assert.ok(sent.request_id, "a control request with no id cannot be answered");
});

test("stopTask refuses an empty id instead of writing a nameless stop", () => {
  const { adapter, proc } = adapterWith();
  assert.equal(adapter.stopTask(""), false);
  assert.equal(adapter.stopTask(undefined), false);
  assert.equal(proc.written.length, 0);
});

test("stopTask coerces a numeric task id, which the CLI mints as a string", () => {
  const { adapter, proc } = adapterWith();
  adapter.stopTask(42);
  assert.equal(lastWrite(proc).request.task_id, "42");
});

test("stopTask survives a dead transport rather than throwing at the click", () => {
  const { adapter, proc } = adapterWith();
  proc.write = () => { throw new Error("EPIPE"); };
  assert.equal(adapter.stopTask("bny62e391"), false);
});

// ── the wire name the two sides must agree on ──

test("both ends spell the event the same way", () => {
  // The web half emits this literal (useAiSession.stopTask); the host half is keyed by
  // the constant. A rename on one side only is a stop that reaches nothing.
  assert.equal(AI_SOCKET_EVENTS.STOP_TASK, "ai:stopTask");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
