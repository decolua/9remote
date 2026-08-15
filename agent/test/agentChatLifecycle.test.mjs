// Lifecycle + robustness checks found while re-reading the agent-chat code.
// Each test here encodes a defect the first pass missed.
// Run: node agent/test/agentChatLifecycle.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9r-lifecycle-"));

const sessionMap = await import("../features/terminal/agentSessionMap.js");
const promptStore = await import("../features/agentChat/promptStore.js");
const { setupAgentChatHandlers } = await import("../features/agentChat/agentChatSocket.js");
const { EVENTS, MAX_ACTIVITY_ENTRIES } = await import("../features/agentChat/constants.js");
const { forgetSession } = await import("../features/agentChat/sessionCleanup.js");

sessionMap._setDirForTest(tmp);

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const SID = "session-1";

// Wait for the confirm pass to finish rather than guessing at a duration — the verify
// delay plus keystroke spacing is timing-dependent and a fixed sleep makes tests flaky.
const HELPER_TIMEOUT_MS = 5000;
const waitForEmit = async (socket, events, timeoutMs = HELPER_TIMEOUT_MS) => {
  const wanted = Array.isArray(events) ? events : [events];
  const start = Date.now();
  const seen = socket.emitted.length;
  while (Date.now() - start < timeoutMs) {
    const hit = socket.emitted.slice(seen).find((e) => wanted.includes(e.event));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
};
const settleConfirm = (socket) => waitForEmit(socket, [EVENTS.PROMPT, EVENTS.PROMPT_CLEARED]);


class FakeSocket extends EventEmitter {
  constructor() { super(); this.emitted = []; }
  emit(event, ...args) {
    if (this.listenerCount(event) > 0 && !String(event).startsWith("agentChat:prompt")) {
      return super.emit(event, ...args);
    }
    this.emitted.push({ event, args });
    return true;
  }
  fire(event, payload) {
    return new Promise((resolve) => {
      const h = this.listeners(event);
      if (!h.length) return resolve({ success: false });
      h[0](payload, resolve);
    });
  }
}

let fakeScreen = "";
const sentInput = [];
const fakeIo = {
  write(sessions, sessionId, data) {
    if (!sessions.get(sessionId)) return false;
    sentInput.push(data);
    return true;
  },
  readScreen: async () => fakeScreen,
};

const PERMISSION_SCREEN = "Do you want to proceed?\n  1. Yes\n  2. No\n";

function world({ screen = "" } = {}) {
  promptStore._resetAllForTest();
  sessionMap._resetForTest();
  try { fs.unlinkSync(sessionMap._fileForTest()); } catch {}
  sentInput.length = 0;
  fakeScreen = screen;
  const sessions = new Map([[SID, { daemon: true }]]);
  const socket = new FakeSocket();
  setupAgentChatHandlers(socket, sessions, fakeIo);
  return { socket, sessions };
}

const hook = (o) => promptStore.ingestHookEvent({ sessionId: SID, tool: "claude", ...o });

/* ================= cleanup: state must not outlive the pane ================= */

await test("deleting a session forgets its prompt and timeline", () => {
  world();
  hook({ event: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: "/a" } } });
  hook({ event: "PermissionRequest", payload: { tool_name: "Bash" } });

  forgetSession(SID);

  assert.equal(promptStore.getPrompt(SID), null);
  assert.equal(promptStore.getActivity(SID).length, 0);
});

await test("deleting a session removes its entry from the persisted map", () => {
  world();
  sessionMap.recordHookEvent({ sessionId: SID, tool: "claude", event: "SessionStart", payload: { session_id: "p1", cwd: "/w" } });
  assert.ok(sessionMap.getMapping(SID));

  forgetSession(SID);

  assert.equal(sessionMap.getMapping(SID), null, "the state file would grow forever otherwise");
  sessionMap._resetForTest();
  assert.equal(sessionMap.getMapping(SID), null, "and it must be gone from disk, not just memory");
});

await test("forgetting an unknown session is harmless", () => {
  world();
  forgetSession("never-existed");
  forgetSession(undefined);
  assert.ok(true);
});

/* ================= stale answers ================= */

await test("a prompt that could not be answered keeps its id so a retry still matches", async () => {
  const { socket } = world({ screen: PERMISSION_SCREEN });
  hook({ event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "x" } } });
  const before = promptStore.getPrompt(SID).promptId;

  await socket.fire(EVENTS.RESPOND, { sessionId: SID, promptId: before, choice: { action: "allow" } });
  await settleConfirm(socket);

  const after = promptStore.getPrompt(SID);
  assert.ok(after, "the card stays up");
  assert.equal(after.promptId, before, "a changed id would make the user's retry bounce as out-of-date");
});

await test("a retry after a stale answer is accepted", async () => {
  const { socket } = world({ screen: PERMISSION_SCREEN });
  hook({ event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "x" } } });
  const id = promptStore.getPrompt(SID).promptId;

  await socket.fire(EVENTS.RESPOND, { sessionId: SID, promptId: id, choice: { action: "allow" } });
  await settleConfirm(socket);
  sentInput.length = 0;

  const res = await socket.fire(EVENTS.RESPOND, { sessionId: SID, promptId: id, choice: { action: "allow" } });
  assert.equal(res.success, true);
  assert.equal(sentInput.length, 1);
  await settleConfirm(socket);
});

/* ================= bounded memory ================= */

await test("a long-running session does not grow its timeline without bound", () => {
  world();
  for (let i = 0; i < MAX_ACTIVITY_ENTRIES * 2; i++) {
    hook({ event: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: `/f${i}` } } });
    hook({ event: "PostToolUse", payload: { tool_name: "Read", tool_response: "x" } });
  }
  assert.equal(promptStore.getActivity(SID).length, MAX_ACTIVITY_ENTRIES);
});

await test("tool output is truncated before it is stored", () => {
  world();
  const huge = "x".repeat(500_000);
  hook({ event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "cat big" } } });
  hook({ event: "PostToolUse", payload: { tool_name: "Bash", tool_response: huge } });
  const stored = promptStore.getActivity(SID)[0].toolResponse;
  assert.ok(stored.length < huge.length, "a single cat of a large file would otherwise pin megabytes per pane");
});

await test("a huge tool input is truncated too", () => {
  world();
  hook({ event: "PreToolUse", payload: { tool_name: "Write", tool_input: { file_path: "/a", content: "y".repeat(500_000) } } });
  const stored = JSON.stringify(promptStore.getActivity(SID)[0].toolInput);
  assert.ok(stored.length < 300_000);
});

/* ================= concurrency ================= */

await test("two answers racing on the same prompt: only the first reaches the pty", async () => {
  const { socket } = world({ screen: PERMISSION_SCREEN });
  hook({ event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "x" } } });
  const id = promptStore.getPrompt(SID).promptId;

  const [a, b] = await Promise.all([
    socket.fire(EVENTS.RESPOND, { sessionId: SID, promptId: id, choice: { action: "allow" } }),
    socket.fire(EVENTS.RESPOND, { sessionId: SID, promptId: id, choice: { action: "deny" } }),
  ]);

  const accepted = [a, b].filter((r) => r.success).length;
  assert.equal(accepted, 1, "both succeeding would type two answers into one selector");
  assert.equal(sentInput.length, 1);
  await settleConfirm(socket);
});

await test("the lock is released once the keys are out, not held through the confirm pass", async () => {
  const { socket } = world({ screen: PERMISSION_SCREEN });
  hook({ event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "one" } } });
  const first = promptStore.getPrompt(SID).promptId;
  await socket.fire(EVENTS.RESPOND, { sessionId: SID, promptId: first, choice: { action: "allow" } });

  // The CLI acts and immediately asks the next question — the user must be able to answer
  // it without waiting out the previous answer's confirmation delay.
  promptStore.clearPrompt(SID);
  hook({ event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "two" } } });
  const second = promptStore.getPrompt(SID).promptId;
  sentInput.length = 0;

  const res = await socket.fire(EVENTS.RESPOND, { sessionId: SID, promptId: second, choice: { action: "allow" } });
  assert.equal(res.success, true, "the second prompt must not be blocked by the first answer's verify wait");
  assert.equal(sentInput.length, 1);
  await settleConfirm(socket);
});

await test("the confirm pass does not resurrect a card the CLI has moved past", async () => {
  const { socket } = world({ screen: PERMISSION_SCREEN });
  hook({ event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "one" } } });
  const first = promptStore.getPrompt(SID).promptId;

  await socket.fire(EVENTS.RESPOND, { sessionId: SID, promptId: first, choice: { action: "allow" } });
  // A different prompt arrives before the confirm pass wakes up.
  promptStore.clearPrompt(SID);
  hook({ event: "PermissionRequest", payload: { tool_name: "Read", tool_input: { file_path: "/a" } } });
  await settleConfirm(socket);

  assert.equal(promptStore.getPrompt(SID).toolName, "Read", "the stale check must not overwrite the newer card");
});

/* ================= input hygiene ================= */

await test("a pasted multi-line message does not fire several commands", async () => {
  const { socket } = world({ screen: "$ " });
  await socket.fire(EVENTS.SEND_TEXT, { sessionId: SID, text: "line one\nrm -rf /\nline three" });
  const sent = sentInput.join("");
  assert.equal(sent.split("\r").length - 1, 1, "each newline would submit separately — a pasted block could run commands the user never sent");
});

await test("an over-long message is rejected rather than flooding the pty", async () => {
  const { socket } = world({ screen: "$ " });
  const res = await socket.fire(EVENTS.SEND_TEXT, { sessionId: SID, text: "z".repeat(200_000) });
  assert.equal(res.success, false);
  assert.equal(sentInput.length, 0);
});

await test("a non-string message is rejected", async () => {
  const { socket } = world({ screen: "$ " });
  assert.equal((await socket.fire(EVENTS.SEND_TEXT, { sessionId: SID, text: { evil: 1 } })).success, false);
  assert.equal((await socket.fire(EVENTS.SEND_TEXT, { sessionId: SID, text: 42 })).success, false);
  assert.equal(sentInput.length, 0);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
