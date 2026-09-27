// Tests for the AI agent status state machine (idle/working/blocked/done).
// Run: node agent/test/statusManager.test.mjs
import assert from "node:assert/strict";
import {
  STATES, TYPE_TO_STATE, applyEvent, getStatus, getStatuses,
  clearStatus, setStatus, onClearStatus, getNotifications,
  onProcessChange, confirmShellClear, getSessionAgent, reapExpired, clearSessionAgent, forgetSession,
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

// Two feeders write the status map — a CLI's hooks and, for a chat session, the adapter
// running in this process. These pin the rules that decide between them, and the one
// place the reaper used to swallow a completion.
await test("a reaped session still reports the completion that follows", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s4", tool: "claude" });
  assert.deepEqual(reapExpired(Date.now() + 120000), ["s4"], "the quiet turn is dropped");
  const e = applyEvent({ type: "done", sessionId: "s4", tool: "claude" });
  assert.equal(e?.state, STATES.DONE, "the badge must survive a quiet stretch");
});

await test("a cleared agent still reports its completion", () => {
  // clearSessionAgent is the TUI exiting, not the terminal going away: a turn that was
  // reaped mid-flight and then exits must still show the badge on its way out.
  reset();
  applyEvent({ type: "working", sessionId: "s5", tool: "claude" });
  reapExpired(Date.now() + 120000);
  clearSessionAgent("s5");
  const e = applyEvent({ type: "done", sessionId: "s5", tool: "claude" });
  assert.equal(e?.state, STATES.DONE);
});

await test("forgetting a session does not reopen the door to a late done", () => {
  // forgetSession is the teardown. The id is minted from a timestamp and gets inherited
  // by whichever session lands on the same value next, so the marker must go with it —
  // otherwise that new session's first stray `done` paints a badge it never earned.
  reset();
  applyEvent({ type: "working", sessionId: "s5b", tool: "claude" });
  reapExpired(Date.now() + 120000);
  forgetSession("s5b");
  const e = applyEvent({ type: "done", sessionId: "s5b", tool: "claude" });
  assert.equal(e, null, "the next tenant of this id starts clean");
});

// The adapter cannot see that the CLI is sitting on an approval prompt, so its
// restatements of "the turn is moving" say nothing about the gate. They are filtered in
// aiSocket (see aiStatus.restatesOverGate); this pins the state machine they land on.
await test("a prompt sent while blocked is the ordering the filter exists for", () => {
  reset();
  applyEvent({ type: "blocked", sessionId: "s6", tool: "claude" });
  assert.equal(getStatus("s6").state, STATES.BLOCKED);
});

await test("resolve still clears the gate", () => {
  reset();
  applyEvent({ type: "blocked", sessionId: "s7", tool: "claude" });
  const e = applyEvent({ type: "working", sessionId: "s7", tool: "claude" });
  assert.equal(e.state, STATES.WORKING);
});

await test("a turn ending after a blocked one still reports done", () => {
  // A status left behind by a previous turn must never outrank the next one: a chat that
  // was blocked or finished has to be able to go back to working when a prompt arrives.
  reset();
  applyEvent({ type: "blocked", sessionId: "s8", tool: "claude" });
  applyEvent({ type: "done", sessionId: "s8", tool: "claude" });
  const e = applyEvent({ type: "working", sessionId: "s8", tool: "claude" });
  assert.equal(e.state, STATES.WORKING, "a new turn must be able to leave done behind");
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
  applyEvent({ type: "working", sessionId: "s1", tool: "opencode" });
  applyEvent({ type: "done", sessionId: "s1" });
  assert.equal(getStatus("s1").tool, "opencode");
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
  // The reading is held; a still-shell re-read is what settles it as an exit.
  assert.equal(onProcessChange("s1", "zsh")?.state, "pendingShell");
  const res = confirmShellClear("s1", "zsh");
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

// The foreground reading is the PROCESS GROUP LEADER, and a coding agent's own Bash
// tool gives it to a shell whenever it runs anything piped (`cmd | tail`, verified
// against pty.process on macOS). Both the agent icon and the conversation hang off
// this one call, so a reading must be confirmed before it clears anything.
await test("a single shell reading does not clear a running agent's conversation", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s1", tool: "claude" });
  onProcessChange("s1", "claude");
  assert.equal(getSessionAgent("s1"), "claude");

  const res = onProcessChange("s1", "zsh");
  assert.equal(res?.state, "pendingShell", "held for confirmation, not acted on");
  assert.equal(getSessionAgent("s1"), "claude", "claude survives (icon stays in statusState)");
  assert.equal(getStatus("s1")?.state, STATES.WORKING, "still working");

  // The tool ends and the agent is back in front — the held reading is discarded.
  assert.equal(confirmShellClear("s1", "claude"), null, "confirmed as not-exited");
  assert.equal(getSessionAgent("s1"), "claude");
  assert.equal(getStatus("s1")?.state, STATES.WORKING);
});

await test("a confirmed shell reading clears the conversation and state", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s2", tool: "claude" });
  onProcessChange("s2", "claude");
  onProcessChange("s2", "zsh");
  const res = confirmShellClear("s2", "zsh");
  assert.deepEqual(res, { state: STATES.IDLE, tool: null, conversationId: null });
  assert.equal(getStatus("s2"), null, "state cleared");
  assert.equal(getSessionAgent("s2"), null, "agent cleared — nothing runs this chat any more");
  // A later shell reading must not re-arm the hold now the entry is gone.
  assert.equal(onProcessChange("s2", "zsh"), null, "no churn at a bare prompt");
});

await test("confirmShellClear ignores a session with nothing pending", () => {
  reset();
  applyEvent({ type: "working", sessionId: "s3", tool: "claude" });
  assert.equal(confirmShellClear("s3", "zsh"), null);
  assert.equal(getStatus("s3")?.state, STATES.WORKING, "untouched");
});

await test("a piped tool call does not cost the agent icon or the conversation", () => {
  reset();
  applyEvent({ type: "working", sessionId: "pipe", tool: "claude" });
  onProcessChange("pipe", "claude");
  // `ls -la 2>&1 | tail -n 200` — measured: pty.process reads "zsh" for this.
  onProcessChange("pipe", "zsh");
  confirmShellClear("pipe", "claude");
  assert.equal(getSessionAgent("pipe"), "claude");
  assert.equal(getStatus("pipe")?.state, STATES.WORKING);
});
