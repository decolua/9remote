// Tests for the AI agent status state machine (idle/working/blocked/done).
// Run: node agent/test/statusManager.test.mjs
import assert from "node:assert/strict";
import {
  STATES, TYPE_TO_STATE, applyEvent, getStatus, getStatuses,
  clearStatus, setStatus, onClearStatus, getNotifications,
  onProcessChange, getSessionAgent,
} from "../features/terminal/statusManager.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// Reset state before each suite — statusManager keeps a module-level Map.
// Uses setStatus(id, undefined) since clearStatus only drops DONE entries (by design).
function reset() {
  for (const id of Object.keys(getStatuses())) setStatus(id, undefined);
}

await test("working → WORKING state with tool + since", () => {
  reset();
  const e = applyEvent({ type: "working", sessionId: "s1", tool: "claude" });
  assert.equal(e.state, STATES.WORKING);
  assert.equal(e.tool, "claude");
  assert.equal(typeof e.since, "number");
});

await test("legacy type 'stop' maps to DONE", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "x" });
  const e = applyEvent({ type: "stop", sessionId: "s1", tool: "x" });
  assert.equal(e.state, STATES.DONE);
});

await test("legacy type 'notification' maps to BLOCKED", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "x" });
  const e = applyEvent({ type: "notification", sessionId: "s1", tool: "x" });
  assert.equal(e.state, STATES.BLOCKED);
});

await test("stray DONE on IDLE is ignored (returns null)", () => {
  reset();
  const e = applyEvent({ type: "done", sessionId: "s2", tool: "codex" });
  assert.equal(e, null);
  assert.equal(getStatus("s2"), null);
});

await test("stray 'stop' on IDLE is ignored", () => {
  reset();
  applyEvent({ type: "stop", sessionId: "s3", tool: "codex" });
  assert.equal(getStatus("s3"), null);
});

await test("full transition working → blocked → working → done", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "claude" });
  assert.equal(getStatus("s1").state, STATES.WORKING);
  applyEvent({ type: "blocked", sessionId: "s1", tool: "claude" });
  assert.equal(getStatus("s1").state, STATES.BLOCKED);
  applyEvent({ type: "working", sessionId: "s1", tool: "claude" });
  assert.equal(getStatus("s1").state, STATES.WORKING);
  applyEvent({ type: "done", sessionId: "s1", tool: "claude" });
  assert.equal(getStatus("s1").state, STATES.DONE);
});

await test("same-state no-op keeps entry, avoids spurious change", () => {
  reset();
  const a = applyEvent({ type: "working", sessionId: "s1", tool: "claude" });
  const b = applyEvent({ type: "working", sessionId: "s1", tool: "claude" });
  assert.equal(a.since, b.since);
});

await test("clearStatus removes DONE entry + fires callback", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "x" });
  applyEvent({ type: "done", sessionId: "s1", tool: "x" });
  let cleared = null;
  const off = onClearStatus((id) => { cleared = id; });
  clearStatus("s1");
  assert.equal(getStatus("s1"), null);
  assert.equal(cleared, "s1");
  off();
});

await test("clearStatus does NOT clear working (focus must not drop running state)", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "x" });
  let cleared = null;
  const off = onClearStatus((id) => { cleared = id; });
  clearStatus("s1");
  assert.equal(getStatus("s1")?.state, STATES.WORKING, "working preserved on focus");
  assert.equal(cleared, null, "no clear callback fired");
  off();
});

await test("clearStatus does NOT clear blocked", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "x" });
  applyEvent({ type: "blocked", sessionId: "s1", tool: "x" });
  clearStatus("s1");
  assert.equal(getStatus("s1")?.state, STATES.BLOCKED);
  reset();
});

await test("getStatuses returns a snapshot of all sessions", () => {
  reset();
  applyEvent({ type: "working", sessionId: "a", tool: "x" });
  applyEvent({ type: "working", sessionId: "b", tool: "x" });
  applyEvent({ type: "done", sessionId: "b", tool: "x" }); // done valid only after working
  applyEvent({ type: "blocked", sessionId: "c", tool: "x" });
  const all = getStatuses();
  assert.deepEqual(Object.keys(all).sort(), ["a", "b", "c"]);
  assert.equal(all.a.state, STATES.WORKING);
  assert.equal(all.b.state, STATES.DONE);
});

await test("tool is retained across state transitions if omitted", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "gemini" });
  applyEvent({ type: "done", sessionId: "s1" });
  assert.equal(getStatus("s1").tool, "gemini");
});

await test("getNotifications (legacy shim) exposes done/blocked only", () => {
  reset();
  applyEvent({ type: "working", sessionId: "w", tool: "x" });
  applyEvent({ type: "working", sessionId: "d", tool: "x" });
  applyEvent({ type: "done", sessionId: "d", tool: "x" });
  applyEvent({ type: "working", sessionId: "b", tool: "x" });
  applyEvent({ type: "blocked", sessionId: "b", tool: "x" });
  const n = getNotifications();
  assert.equal(n.w, undefined, "working should not appear in legacy map");
  assert.ok(n.d, "done should appear");
  assert.ok(n.b, "blocked should appear");
  assert.equal(n.d.type, STATES.DONE);
  assert.equal(n.b.type, STATES.BLOCKED);
});

await test("setStatus sets arbitrary entry, undefined deletes", () => {
  reset();
  setStatus("s1", { state: STATES.IDLE, tool: "x" });
  assert.equal(getStatus("s1").state, STATES.IDLE);
  setStatus("s1", undefined);
  assert.equal(getStatus("s1"), null);
});

await test("TYPE_TO_STATE covers all legacy + new types", () => {
  assert.equal(TYPE_TO_STATE.stop, STATES.DONE);
  assert.equal(TYPE_TO_STATE.notification, STATES.BLOCKED);
  assert.equal(TYPE_TO_STATE.working, STATES.WORKING);
  assert.equal(TYPE_TO_STATE.done, STATES.DONE);
  assert.equal(TYPE_TO_STATE.blocked, STATES.BLOCKED);
  assert.equal(TYPE_TO_STATE.idle, STATES.IDLE);
});

await test("onProcessChange preserves DONE state and badge when returning to shell", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "claude" });
  applyEvent({ type: "done", sessionId: "s1", tool: "claude" });
  assert.equal(getStatus("s1")?.state, STATES.DONE);

  // Return to shell after task completed
  const res = onProcessChange("s1", "zsh");
  assert.equal(res, null, "must not return idle when state is DONE");
  assert.equal(getStatus("s1")?.state, STATES.DONE, "DONE state preserved");
  assert.equal(getStatus("s1")?.tool, "claude", "tool preserved for badge");
});

await test("onProcessChange preserves BLOCKED state when returning to shell", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "claude" });
  applyEvent({ type: "blocked", sessionId: "s1", tool: "claude" });
  const res = onProcessChange("s1", "bash");
  assert.equal(res, null, "must not return idle when state is BLOCKED");
  assert.equal(getStatus("s1")?.state, STATES.BLOCKED);
});

await test("onProcessChange resets WORKING to idle when interrupted/exited to shell", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "claude" });
  const res = onProcessChange("s1", "zsh");
  assert.deepEqual(res, { state: STATES.IDLE, tool: null, conversationId: null });
  assert.equal(getStatus("s1"), null, "status cleared");
});

await test("onProcessChange sets agent when process is an agent binary", () => {
  reset();
  const res = onProcessChange("s1", "claude");
  assert.deepEqual(res, { agentId: "claude" });
  assert.equal(getSessionAgent("s1"), "claude");
});

console.log(`\n${fail ? `❌ ${fail} failed` : "✅ all passed"}, ${pass} passed`);
if (fail) process.exit(1);
