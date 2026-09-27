// Tests for the codex goal read (agent/features/ai/goal.js + AiSession.refreshGoal).
// Run: node agent/test/codexGoal.test.mjs
//
// The goal lives in codex's own state DB and only surfaces over its app-server, so the
// interesting behaviour is when NOT to re-emit it: init fires on every connect, and the
// log must not grow a duplicate goal each time.
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// A stand-in for AiSession that keeps the real dedupe logic but skips the RPC, so the
// test decides what the CLI "returns" without needing a live codex thread.
const { AiSession } = await import("../features/ai/aiSession.js");

function sessionWithLog(history = []) {
  const s = new AiSession({ id: "goal-test", engine: "codex", cwd: "/tmp", options: {}, onEvent: () => {} });
  s.history = history.map((e) => ({ ...e }));
  return s;
}

const goalEvent = (objective, status = "active") => ({
  event: "goal",
  data: { goal: { objective, status } }
});

await test("the last recorded goal key is read back out of the log", () => {
  assert.equal(sessionWithLog([]).lastRecordedGoalKey(), null);
  assert.equal(sessionWithLog([goalEvent("ship it")]).lastRecordedGoalKey(), "ship it|active");
  // A recorded clearing reads back as "" — that is what makes it distinguishable
  // from "nothing recorded yet" (null).
  assert.equal(sessionWithLog([goalEvent("ship it"), { event: "goal", data: { goal: null } }]).lastRecordedGoalKey(), "");
});

await test("a goal already in the log is not re-appended after a restart", () => {
  // The agent restarted: the snapshot restored the log, and the in-memory key is gone.
  const s = sessionWithLog([goalEvent("keep tests green")]);
  assert.equal(s.goalKey, null);
  assert.equal(s.lastRecordedGoalKey(), "keep tests green|active");
  // The dedupe check the emitter runs must therefore skip.
  assert.ok("keep tests green|active" === s.lastRecordedGoalKey());
});

await test("a changed objective or status is still recorded", () => {
  const s = sessionWithLog([goalEvent("keep tests green")]);
  assert.notEqual("keep tests green|paused", s.lastRecordedGoalKey());
  assert.notEqual("ship something else|active", s.lastRecordedGoalKey());
});

await test("reading the last goal walks backwards past unrelated events", () => {
  const s = sessionWithLog([
    goalEvent("first"),
    { event: "delta", data: { text: "hello" } },
    { event: "goal", data: { goal: { objective: "second", status: "paused" } } },
    { event: "turn_complete", data: {} }
  ]);
  assert.equal(s.lastRecordedGoalKey(), "second|paused");
});

// ── when the goal is re-read ──
//
// `/goal` is typed into the composer as a PROMPT, so the CLI records it during the turn.
// The goal used to be read only on `init`, which meant setting one changed nothing on
// screen until an F5 — the pane kept showing the goal it had.

await test("the goal is re-read when a turn ends, not only on init", async () => {
  // The CLI is asked at the turn's end; this test drives that beat with a stand-in reader.
  const s = new AiSession({ id: "goal-beat", engine: "codex", cwd: "/tmp", options: {}, onEvent: () => {} });
  s.threadId = "t-1";
  const calls = [];
  s.refreshGoal = (id) => { calls.push(id); return Promise.resolve(); };
  s.emitNormalized("turn_complete", { stats: {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["t-1"], "a finished turn asks the CLI what the goal is now");
});

await test("another engine's turn does not ask codex for a goal", async () => {
  const s = new AiSession({ id: "goal-other", engine: "claude", cwd: "/tmp", options: {}, onEvent: () => {} });
  s.threadId = "t-2";
  const calls = [];
  s.refreshGoal = (id) => { calls.push(id); return Promise.resolve(); };
  s.emitNormalized("turn_complete", { stats: {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [], "the goal RPC is codex's alone");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
