// Unit tests for the agent-chat prompt store: what the TUI is blocked on, per pane.
// Run: node agent/test/agentChatPromptStore.test.mjs
import assert from "node:assert/strict";

const {
  ingestHookEvent, getPrompt, clearPrompt, getActivity,
  getSnapshot, resetSession, _resetAllForTest,
} = await import("../features/agentChat/promptStore.js");
const { PROMPT_KINDS, MAX_ACTIVITY_ENTRIES } = await import("../features/agentChat/constants.js");

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const ev = (o) => ({ sessionId: "s1", tool: "claude", ...o });

/* ---- classification: by tool_name, never by event name ---- */

await test("PermissionRequest with a plain tool → permission", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "ls" } } }));
  const p = getPrompt("s1");
  assert.equal(p.kind, PROMPT_KINDS.PERMISSION);
  assert.equal(p.toolName, "Bash");
});

await test("AskUserQuestion arriving as PermissionRequest is still a question", () => {
  _resetAllForTest();
  // Newer Claude reports the AskUserQuestion wait under the PermissionRequest event.
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "AskUserQuestion", tool_input: { questions: [] } } }));
  assert.equal(getPrompt("s1").kind, PROMPT_KINDS.QUESTION);
});

await test("ExitPlanMode → plan, in both casings", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "ExitPlanMode", tool_input: { plan: "# hi" } } }));
  assert.equal(getPrompt("s1").kind, PROMPT_KINDS.PLAN);
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PreToolUse", payload: { tool_name: "exit_plan_mode", tool_input: { plan: "# hi" } } }));
  assert.equal(getPrompt("s1").kind, PROMPT_KINDS.PLAN);
});

await test("an unknown tool name still yields a usable permission prompt", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "SomeFutureTool" } }));
  assert.equal(getPrompt("s1").kind, PROMPT_KINDS.PERMISSION);
});

/* ---- prompt lifecycle ---- */

await test("each prompt gets a distinct id", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "Bash" } }));
  const first = getPrompt("s1").promptId;
  clearPrompt("s1");
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "Read" } }));
  assert.notEqual(getPrompt("s1").promptId, first);
});

await test("the same permission request repeated does not churn the id", () => {
  _resetAllForTest();
  const p = { tool_name: "Bash", tool_input: { command: "ls" } };
  ingestHookEvent(ev({ event: "PermissionRequest", payload: p }));
  const id = getPrompt("s1").promptId;
  ingestHookEvent(ev({ event: "PermissionRequest", payload: p }));
  assert.equal(getPrompt("s1").promptId, id, "a re-fired identical hook must not invalidate the card the user is looking at");
});

await test("PostToolUse for the pending tool clears the prompt — it was answered in the TUI", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "ls" } } }));
  ingestHookEvent(ev({ event: "PostToolUse", payload: { tool_name: "Bash", tool_response: "ok" } }));
  assert.equal(getPrompt("s1"), null);
});

await test("Stop clears any pending prompt", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "Bash" } }));
  ingestHookEvent(ev({ event: "Stop", payload: {} }));
  assert.equal(getPrompt("s1"), null);
});

await test("a question is cleared by any following tool work", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "AskUserQuestion" } }));
  // Claude fires no hook after the user answers — unrelated tool work is the signal.
  ingestHookEvent(ev({ event: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: "/a" } } }));
  assert.equal(getPrompt("s1"), null);
});

await test("a permission prompt is NOT cleared by unrelated tool work", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "rm -rf /" } } }));
  ingestHookEvent(ev({ event: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: "/a" } } }));
  assert.ok(getPrompt("s1"), "a destructive permission card must not vanish on a stray unrelated event");
});

await test("clearPrompt is idempotent and safe on an unknown session", () => {
  _resetAllForTest();
  clearPrompt("nope");
  clearPrompt("nope");
  assert.equal(getPrompt("nope"), null);
});

/* ---- prompt payload passthrough ---- */

await test("tool_input is carried through so the GUI can render the real question", () => {
  _resetAllForTest();
  const questions = [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }];
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "AskUserQuestion", tool_input: { questions } } }));
  assert.deepEqual(getPrompt("s1").toolInput.questions, questions);
});

await test("a prompt records the launch token that produced it", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", launchToken: "tok-a", payload: { tool_name: "Bash" } }));
  assert.equal(getPrompt("s1").launchToken, "tok-a");
});

/* ---- activity timeline ---- */

await test("PreToolUse opens an activity entry, PostToolUse completes it", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: "/a.js" } } }));
  let a = getActivity("s1");
  assert.equal(a.length, 1);
  assert.equal(a[0].status, "running");
  ingestHookEvent(ev({ event: "PostToolUse", payload: { tool_name: "Read", tool_response: "contents" } }));
  a = getActivity("s1");
  assert.equal(a.length, 1, "the completion updates the open entry rather than appending a second row");
  assert.equal(a[0].status, "done");
  assert.equal(a[0].toolResponse, "contents");
});

await test("a PostToolUse with no matching open entry still lands as a completed row", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PostToolUse", payload: { tool_name: "Bash", tool_response: "out" } }));
  const a = getActivity("s1");
  assert.equal(a.length, 1);
  assert.equal(a[0].status, "done");
});

await test("PostToolUseFailure marks the entry as error", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "false" } } }));
  ingestHookEvent(ev({ event: "PostToolUseFailure", payload: { tool_name: "Bash", tool_response: "exit 1" } }));
  assert.equal(getActivity("s1")[0].status, "error");
});

await test("two concurrent tools complete independently", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: "/a" } } }));
  ingestHookEvent(ev({ event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "ls" } } }));
  ingestHookEvent(ev({ event: "PostToolUse", payload: { tool_name: "Read", tool_response: "A" } }));
  const a = getActivity("s1");
  assert.equal(a.length, 2);
  assert.equal(a.find((x) => x.toolName === "Read").status, "done");
  assert.equal(a.find((x) => x.toolName === "Bash").status, "running");
});

await test("activity is capped and keeps the newest entries", () => {
  _resetAllForTest();
  for (let i = 0; i < MAX_ACTIVITY_ENTRIES + 25; i++) {
    ingestHookEvent(ev({ event: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: `/f${i}` } } }));
    ingestHookEvent(ev({ event: "PostToolUse", payload: { tool_name: "Read", tool_response: "x" } }));
  }
  const a = getActivity("s1");
  assert.equal(a.length, MAX_ACTIVITY_ENTRIES);
  assert.match(JSON.stringify(a[a.length - 1].toolInput), /f\d+/);
});

await test("UserPromptSubmit records the prompt the user typed in the TUI", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "UserPromptSubmit", payload: { prompt: "fix the bug" } }));
  const a = getActivity("s1");
  assert.equal(a[0].kind, "userPrompt");
  assert.equal(a[0].text, "fix the bug");
});

/* ---- isolation + snapshot ---- */

await test("sessions do not leak into each other", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ sessionId: "s1", event: "PermissionRequest", payload: { tool_name: "Bash" } }));
  ingestHookEvent(ev({ sessionId: "s2", event: "PreToolUse", payload: { tool_name: "Read", tool_input: {} } }));
  assert.ok(getPrompt("s1"));
  assert.equal(getPrompt("s2"), null);
  assert.equal(getActivity("s1").length, 0);
  assert.equal(getActivity("s2").length, 1);
});

await test("snapshot returns prompt + activity together for reconnect replay", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: "/a" } } }));
  ingestHookEvent(ev({ event: "PermissionRequest", payload: { tool_name: "Bash" } }));
  const snap = getSnapshot("s1");
  assert.ok(snap.prompt);
  assert.equal(snap.activity.length, 1);
});

await test("resetSession wipes one pane only", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ sessionId: "s1", event: "PermissionRequest", payload: { tool_name: "Bash" } }));
  ingestHookEvent(ev({ sessionId: "s2", event: "PermissionRequest", payload: { tool_name: "Bash" } }));
  resetSession("s1");
  assert.equal(getPrompt("s1"), null);
  assert.ok(getPrompt("s2"));
});

await test("an event with no sessionId is dropped", () => {
  _resetAllForTest();
  ingestHookEvent({ tool: "claude", event: "PermissionRequest", payload: { tool_name: "Bash" } });
  assert.deepEqual(getSnapshot("").activity, []);
});

await test("a malformed payload never throws", () => {
  _resetAllForTest();
  ingestHookEvent(ev({ event: "PermissionRequest", payload: null }));
  ingestHookEvent(ev({ event: "PreToolUse" }));
  ingestHookEvent(ev({ event: undefined, payload: {} }));
  assert.ok(true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
