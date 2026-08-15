// End-to-end: a hook payload arriving from the AI CLI travels through mapping + prompt
// store + socket, and a GUI button press comes back out as keystrokes on the PTY.
// The daemon and PTY are faked; everything between them is the real code.
// Run: node agent/test/agentChatE2E.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9r-agentchat-e2e-"));

/* ---- stand in for the PTY: what the screen shows, and what we typed into it ---- */
let fakeScreen = "";
const sentInput = [];
const fakeIo = {
  write(sessions, sessionId, data) {
    if (!sessions.get(sessionId)) return false;
    sentInput.push({ sessionId, data });
    return true;
  },
  readScreen: async () => fakeScreen,
};

const { setupAgentChatHandlers } = await import("../features/agentChat/agentChatSocket.js");
const { EVENTS, KEYS, PROMPT_KINDS } = await import("../features/agentChat/constants.js");
const promptStore = await import("../features/agentChat/promptStore.js");
const sessionMap = await import("../features/terminal/agentSessionMap.js");

sessionMap._setDirForTest(tmp);

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

/* ---- harness ---- */

// A socket.io-shaped double: handlers registered via .on, invoked via .fire.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.emitted = []; }
  emit(event, ...args) {
    // Handlers are registered with .on; server→client sends are recorded, not dispatched.
    if (this.listenerCount(event) > 0 && event !== EVENTS.PROMPT && event !== EVENTS.PROMPT_CLEARED) {
      return super.emit(event, ...args);
    }
    this.emitted.push({ event, args });
    return true;
  }
  fire(event, payload) {
    return new Promise((resolve) => {
      const handlers = this.listeners(event);
      if (!handlers.length) return resolve({ success: false, error: "no handler" });
      handlers[0](payload, resolve);
    });
  }
}

const PTY_SESSION = "session-1";

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


function freshWorld({ screen = "", withPty = true } = {}) {
  promptStore._resetAllForTest();
  sessionMap._resetForTest();
  try { fs.unlinkSync(sessionMap._fileForTest()); } catch {}
  sentInput.length = 0;
  fakeScreen = screen;
  const sessions = new Map();
  if (withPty) sessions.set(PTY_SESSION, { daemon: true });
  const socket = new FakeSocket();
  setupAgentChatHandlers(socket, sessions, fakeIo);
  return { socket, sessions };
}

// What the agent's /api/notify does with a hook body, minus the transport + broadcast.
function deliverHook({ event, toolName, toolInput, toolResponse, prompt, providerSessionId, cwd, transcriptPath, launchToken }) {
  const payload = {
    hook_event_name: event,
    ...(providerSessionId ? { session_id: providerSessionId } : {}),
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    ...(cwd ? { cwd } : {}),
    ...(toolName ? { tool_name: toolName } : {}),
    ...(toolInput ? { tool_input: toolInput } : {}),
    ...(toolResponse ? { tool_response: toolResponse } : {}),
    ...(prompt ? { prompt } : {}),
  };
  if (!sessionMap.isLaunchTokenCurrent(PTY_SESSION, launchToken)) return null;
  sessionMap.recordHookEvent({ sessionId: PTY_SESSION, tool: "claude", event, launchToken, payload });
  return promptStore.ingestHookEvent({ sessionId: PTY_SESSION, tool: "claude", event, launchToken, payload });
}

const PERMISSION_SCREEN =
  "\x1b[1mBash\x1b[0m\n  rm -rf build\n\nDo you want to proceed?\n  1. Yes\n  2. No, and tell Claude what to do differently\n";
const IDLE_SCREEN = "$ ls\nbuild  src\n$ ";
const PLAN_SCREEN =
  "Ready to code?\n  1. Yes, and auto-accept edits\n  2. Yes, and manually approve edits\n  3. No, keep planning\n";
// The selector always appends its own two rows below the model's options.
const QUESTION_SCREEN = [
  "Which database should we use?",
  "  1. Postgres",
  "  2. MySQL",
  "  3. SQLite",
  "  4. Type something.",
  "  5. Chat about this",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

/* ================= subscribe / replay ================= */

await test("a pane with no AI session reports hasAgent:false", async () => {
  const { socket } = freshWorld();
  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(res.success, true);
  assert.equal(res.hasAgent, false);
});

await test("SessionStart makes the pane offer the GUI, and names the tool", async () => {
  const { socket } = freshWorld();
  deliverHook({ event: "SessionStart", providerSessionId: "prov-1", cwd: "/work", transcriptPath: "/t/a.jsonl" });
  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(res.hasAgent, true);
  assert.equal(res.tool, "claude");
});

await test("a reconnect replays the pending prompt AND the tool timeline", async () => {
  const { socket } = freshWorld();
  deliverHook({ event: "SessionStart", providerSessionId: "p1", cwd: "/w" });
  deliverHook({ event: "UserPromptSubmit", prompt: "clean the build" });
  deliverHook({ event: "PreToolUse", toolName: "Read", toolInput: { file_path: "/a.js" } });
  deliverHook({ event: "PostToolUse", toolName: "Read", toolResponse: "…" });
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "rm -rf build" } });

  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(res.prompt.kind, PROMPT_KINDS.PERMISSION);
  assert.equal(res.prompt.toolName, "Bash");
  assert.equal(res.activity.length, 2, "user prompt + one completed tool call");
  assert.equal(res.activity[0].kind, "userPrompt");
  assert.equal(res.activity[1].status, "done");
});

await test("subscribe without a session id is rejected", async () => {
  const { socket } = freshWorld();
  const res = await socket.fire(EVENTS.SUBSCRIBE, {});
  assert.equal(res.success, false);
});

/* ================= the happy path ================= */

await test("full loop: hook → prompt → Allow → '1' lands on the PTY", async () => {
  const { socket } = freshWorld({ screen: PERMISSION_SCREEN });
  deliverHook({ event: "SessionStart", providerSessionId: "p1", cwd: "/w" });
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "rm -rf build" } });

  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  const res = await socket.fire(EVENTS.RESPOND, {
    sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { action: "allow" },
  });
  assert.equal(res.success, true);
  assert.deepEqual(sentInput.map((s) => s.data), ["1"]);
  await settleConfirm(socket);
});

await test("Deny sends ESC", async () => {
  const { socket } = freshWorld({ screen: PERMISSION_SCREEN });
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "x" } });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  await socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { action: "deny" } });
  assert.deepEqual(sentInput.map((s) => s.data), [KEYS.ESCAPE]);
  await settleConfirm(socket);   // let this test's confirm pass finish before the next one
});

await test("after the screen clears, the prompt is cleared and clients are told", async () => {
  const { socket } = freshWorld({ screen: PERMISSION_SCREEN });
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "x" } });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  const done = socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { action: "allow" } });
  await done;
  fakeScreen = IDLE_SCREEN;                 // the CLI moved on
  await settleConfirm(socket);

  assert.equal(promptStore.getPrompt(PTY_SESSION), null);
  assert.ok(socket.emitted.some((e) => e.event === EVENTS.PROMPT_CLEARED));
});

await test("if the prompt is still up afterwards, the card is restored as stale", async () => {
  const { socket } = freshWorld({ screen: PERMISSION_SCREEN });
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "x" } });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  await socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { action: "allow" } });
  await settleConfirm(socket);

  const stale = socket.emitted.find((e) => e.event === EVENTS.PROMPT && e.args[0]?.stale);
  assert.ok(stale, "the user must be told their answer did not land");
  assert.ok(promptStore.getPrompt(PTY_SESSION), "the card stays so they can retry or open the TUI");
});

/* ================= the strict gate ================= */

await test("an idle screen refuses the send — nothing reaches the PTY", async () => {
  const { socket } = freshWorld({ screen: PERMISSION_SCREEN });
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "x" } });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  fakeScreen = IDLE_SCREEN;   // already answered in the TUI
  const res = await socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { action: "allow" } });

  assert.equal(res.success, false);
  assert.equal(res.screenChanged, true);
  assert.equal(sentInput.length, 0, "a keystroke into an idle shell would be typed as a literal command");
  await settleConfirm(socket);
});

await test("a second client answering a superseded prompt id is rejected", async () => {
  const { socket } = freshWorld({ screen: PERMISSION_SCREEN });
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "one" } });
  const first = promptStore.getPrompt(PTY_SESSION);
  promptStore.clearPrompt(PTY_SESSION);
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "two" } });

  const res = await socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: first.promptId, choice: { action: "allow" } });
  assert.equal(res.success, false);
  assert.equal(sentInput.length, 0);
  await settleConfirm(socket);
});

await test("responding with no prompt pending is rejected", async () => {
  const { socket } = freshWorld({ screen: IDLE_SCREEN });
  const res = await socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: "p1", choice: { action: "allow" } });
  assert.equal(res.success, false);
  assert.equal(sentInput.length, 0);
});

/* ================= plan ================= */

await test("plan: an explicit option 3 is sent, and only if it exists on screen", async () => {
  const { socket } = freshWorld({ screen: PLAN_SCREEN });
  deliverHook({ event: "PreToolUse", toolName: "ExitPlanMode", toolInput: { plan: "# Plan" } });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(prompt.kind, PROMPT_KINDS.PLAN);

  const res = await socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { optionIndex: 3 } });
  assert.equal(res.success, true);
  assert.deepEqual(sentInput.map((s) => s.data), ["3"]);
  await settleConfirm(socket);
});

await test("plan: a bare 'allow' is refused rather than guessing option 1", async () => {
  const { socket } = freshWorld({ screen: PLAN_SCREEN });
  deliverHook({ event: "PreToolUse", toolName: "ExitPlanMode", toolInput: { plan: "# Plan" } });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  const res = await socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { action: "allow" } });
  assert.equal(res.success, false);
  assert.equal(sentInput.length, 0);
  await settleConfirm(socket);
});

await test("plan: choosing an option the menu no longer has is refused", async () => {
  const { socket } = freshWorld({ screen: "Ready to code?\n  1. Yes\n  2. No, keep planning\n" });
  deliverHook({ event: "PreToolUse", toolName: "ExitPlanMode", toolInput: { plan: "# Plan" } });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  const res = await socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { optionIndex: 3 } });
  assert.equal(res.success, false);
  assert.equal(sentInput.length, 0);
});

/* ================= questions ================= */

await test("question: option then Enter, sent as separate spaced keystrokes", async () => {
  const { socket } = freshWorld({ screen: QUESTION_SCREEN });
  deliverHook({
    event: "PermissionRequest", toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which database should we use?", options: [{ label: "Postgres" }, { label: "MySQL" }, { label: "SQLite" }] }] },
  });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(prompt.kind, PROMPT_KINDS.QUESTION);

  const res = await socket.fire(EVENTS.RESPOND, {
    sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { answers: [{ optionIndex: 1 }] },
  });
  assert.equal(res.success, true);
  assert.deepEqual(sentInput.map((s) => s.data), ["1", KEYS.ENTER]);
  await settleConfirm(socket);
});

await test("question: multi-select is refused instead of typed blind", async () => {
  const { socket } = freshWorld({ screen: QUESTION_SCREEN });
  deliverHook({
    event: "PermissionRequest", toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] },
  });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  const res = await socket.fire(EVENTS.RESPOND, {
    sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { answers: [{ optionIndexes: [1, 2] }] },
  });
  assert.equal(res.success, false);
  assert.equal(sentInput.length, 0);
});

/* ================= free text + interrupt ================= */

await test("typing a message appends Enter", async () => {
  const { socket } = freshWorld({ screen: IDLE_SCREEN });
  const res = await socket.fire(EVENTS.SEND_TEXT, { sessionId: PTY_SESSION, text: "keep going" });
  assert.equal(res.success, true);
  assert.deepEqual(sentInput.map((s) => s.data), [`keep going${KEYS.ENTER}`]);
});

await test("typing is blocked while a choice is pending — the selector would eat it", async () => {
  const { socket } = freshWorld({ screen: PERMISSION_SCREEN });
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "x" } });
  const res = await socket.fire(EVENTS.SEND_TEXT, { sessionId: PTY_SESSION, text: "hello" });
  assert.equal(res.success, false);
  assert.equal(sentInput.length, 0);
});

await test("empty or whitespace-only text is rejected", async () => {
  const { socket } = freshWorld({ screen: IDLE_SCREEN });
  assert.equal((await socket.fire(EVENTS.SEND_TEXT, { sessionId: PTY_SESSION, text: "   " })).success, false);
  assert.equal((await socket.fire(EVENTS.SEND_TEXT, { sessionId: PTY_SESSION })).success, false);
  assert.equal(sentInput.length, 0);
});

await test("interrupt sends Ctrl+C", async () => {
  const { socket } = freshWorld({ screen: IDLE_SCREEN });
  const res = await socket.fire(EVENTS.INTERRUPT, { sessionId: PTY_SESSION });
  assert.equal(res.success, true);
  assert.deepEqual(sentInput.map((s) => s.data), [KEYS.INTERRUPT]);
});

await test("a dead session fails cleanly instead of throwing", async () => {
  const { socket } = freshWorld({ screen: IDLE_SCREEN, withPty: false });
  const res = await socket.fire(EVENTS.SEND_TEXT, { sessionId: PTY_SESSION, text: "hi" });
  assert.equal(res.success, false);
});

/* ================= nested agents ================= */

await test("a nested agent's hooks cannot hijack the pane's prompt or mapping", async () => {
  const { socket } = freshWorld({ screen: PERMISSION_SCREEN });
  deliverHook({ event: "SessionStart", providerSessionId: "parent", cwd: "/w", launchToken: "tok-parent" });
  deliverHook({ event: "PermissionRequest", toolName: "Bash", toolInput: { command: "parent cmd" }, launchToken: "tok-parent" });

  // A subprocess inherits NINE_REMOTE_SESSION_ID but carries its own launch token.
  deliverHook({ event: "SessionStart", providerSessionId: "child", cwd: "/w", launchToken: "tok-child" });
  deliverHook({ event: "Stop", launchToken: "tok-child" });

  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(res.prompt.toolInput.command, "parent cmd", "the child's Stop must not clear the parent's card");
  assert.equal(sessionMap.getMapping(PTY_SESSION).providerSessionId, "parent");
});

/* ================= multi-question: the keys are walked, not fired blind ================= */

const TWO_Q_SCREEN = [
  "←  ☐ Test 1  ☐ Test 2  ✔ Submit→Test câu 1 — chọn một đáp án?❯ 1. A   Đáp án A",
  "2.B",
  "3.C",
  "4.Typesomething.",
  "5.Chataboutthis",
  "Entertoselect·Tab/Arrowkeystonavigate·Esctocancel",
].join("\n");

const twoQuestions = {
  questions: [
    { question: "Test câu 1", options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
    { question: "Test câu 2", multiSelect: true, options: [{ label: "X" }, { label: "Y" }, { label: "Z" }] },
  ],
};

await test("a two-question set is answerable even though one question is multi-select", async () => {
  const { socket } = freshWorld({ screen: TWO_Q_SCREEN });
  deliverHook({ event: "PermissionRequest", toolName: "AskUserQuestion", toolInput: twoQuestions });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  const res = await socket.fire(EVENTS.RESPOND, {
    sessionId: PTY_SESSION, promptId: prompt.promptId,
    choice: { answers: [{ optionIndex: 1 }, { optionIndex: 2 }] },
  });
  assert.equal(res.success, true, "one multi-select question must not block the whole set");
  // Picking an option advances the selector by itself; the trailing Enter presses Submit.
  assert.deepEqual(sentInput.map((s) => s.data), ["1", "2", KEYS.ENTER]);
  await settleConfirm(socket);
});

await test("picking several options in one question is still refused", async () => {
  const { socket } = freshWorld({ screen: TWO_Q_SCREEN });
  deliverHook({ event: "PermissionRequest", toolName: "AskUserQuestion", toolInput: twoQuestions });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  const res = await socket.fire(EVENTS.RESPOND, {
    sessionId: PTY_SESSION, promptId: prompt.promptId,
    choice: { answers: [{ optionIndex: 1 }, { optionIndexes: [1, 2] }] },
  });
  assert.equal(res.success, false, "toggling several rows needs a key sequence we have not verified");
  assert.equal(sentInput.length, 0);
});

await test("the keys stop the moment the screen stops looking like the selector", async () => {
  const { socket } = freshWorld({ screen: TWO_Q_SCREEN });
  deliverHook({ event: "PermissionRequest", toolName: "AskUserQuestion", toolInput: twoQuestions });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  // The user answers in the TUI while the GUI is mid-sequence.
  const original = fakeIo.readScreen;
  let reads = 0;
  fakeIo.readScreen = async () => (++reads > 1 ? IDLE_SCREEN : TWO_Q_SCREEN);

  const res = await socket.fire(EVENTS.RESPOND, {
    sessionId: PTY_SESSION, promptId: prompt.promptId,
    choice: { answers: [{ optionIndex: 1 }, { optionIndex: 2 }] },
  });
  fakeIo.readScreen = original;

  assert.equal(res.success, false, "continuing would type the rest of the sequence into a shell prompt");
  assert.ok(sentInput.length < 4, `sent ${sentInput.length} keys after the screen changed`);
});

await test("a typed answer opens the selector's own input and commits it", async () => {
  const { socket } = freshWorld({ screen: QUESTION_SCREEN });
  deliverHook({
    event: "PermissionRequest", toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] },
  });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  const res = await socket.fire(EVENTS.RESPOND, {
    sessionId: PTY_SESSION, promptId: prompt.promptId,
    choice: { answers: [{ text: "none of these — use SQLite" }] },
  });
  assert.equal(res.success, true);
  // QUESTION_SCREEN shows 3 options, so "Type something." is row 4.
  assert.deepEqual(sentInput.map((s) => s.data), ["4", "none of these — use SQLite", KEYS.ENTER]);
  await settleConfirm(socket);
});

await test("typed text with a newline never reaches the pty", async () => {
  const { socket } = freshWorld({ screen: QUESTION_SCREEN });
  deliverHook({
    event: "PermissionRequest", toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] },
  });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  const res = await socket.fire(EVENTS.RESPOND, {
    sessionId: PTY_SESSION, promptId: prompt.promptId,
    choice: { answers: [{ text: "answer\nrm -rf /" }] },
  });
  assert.equal(res.success, false, "the newline would commit early and run the rest as a command");
  assert.equal(sentInput.length, 0);
});

await test("skip sends ESC — the same thing 'Chat about this' does in the TUI", async () => {
  const { socket } = freshWorld({ screen: QUESTION_SCREEN });
  deliverHook({
    event: "PermissionRequest", toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] },
  });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  await socket.fire(EVENTS.RESPOND, { sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { action: "skip" } });
  assert.deepEqual(sentInput.map((s) => s.data), [KEYS.ESCAPE]);
  await settleConfirm(socket);
});

await test("a single-question answer needs no navigation key", async () => {
  const { socket } = freshWorld({ screen: QUESTION_SCREEN });
  deliverHook({
    event: "PermissionRequest", toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] },
  });
  const { prompt } = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  await socket.fire(EVENTS.RESPOND, {
    sessionId: PTY_SESSION, promptId: prompt.promptId, choice: { answers: [{ optionIndex: 3 }] },
  });
  assert.deepEqual(sentInput.map((s) => s.data), ["3", KEYS.ENTER]);
  await settleConfirm(socket);
});

/* ================= screen mode: no hooks, no transcript — the pane is the source ================= */

await test("a pane with no mapping answers from the parsed screen", async () => {
  const { socket } = freshWorld({ screen: "⏺ Bash(git status)\n  ⎿  clean\n$ " });
  // No SessionStart hook — an unknown CLI the registry has never heard of.
  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(res.source, "screen", "the parser needs nothing but the pane output");
  assert.equal(res.hasAgent, false);
  assert.ok(res.activity.some((e) => e.kind === "tool" && e.tool === "Bash"));
  const tool = res.activity.find((e) => e.kind === "tool");
  assert.match(tool.output, /clean/);
});

await test("screen mode reports the menu the parser read", async () => {
  const { socket } = freshWorld({ screen: "Proceed?\n  1. Yes\n  2. No\nEnter to select · Esc to cancel\n" });
  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  const prompt = res.activity.find((e) => e.kind === "prompt");
  assert.ok(prompt, "a CLI with no hooks still surfaces its menu");
  assert.equal(res.optionCount, 2);
  assert.deepEqual(prompt.options.map((o) => o.label), ["Yes", "No"]);
});

await test("a Claude pane still prefers the transcript over the screen", async () => {
  const { socket } = freshWorld({ screen: "⏺ from screen\n" });
  const tp = path.join(tmp, "t-mode.jsonl");
  fs.writeFileSync(tp, JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "from transcript" }] } }) + "\n");
  deliverHook({ event: "SessionStart", providerSessionId: "p1", cwd: "/w", transcriptPath: tp });
  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(res.source, "transcript");
});

/* ================= the transcript is where the conversation lives ================= */

const writeTranscript = (name, records) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
};

await test("subscribe returns the assistant's prose, which hooks never carry", async () => {
  const { socket } = freshWorld();
  const tp = writeTranscript("t1.jsonl", [
    { type: "user", uuid: "u1", message: { role: "user", content: "why is login failing?" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "The token expiry check uses `<` instead of `<=`." }] } },
  ]);
  deliverHook({ event: "SessionStart", providerSessionId: "p1", cwd: "/w", transcriptPath: tp });

  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(res.source, "transcript");
  const said = res.activity.find((r) => r.kind === "assistantText");
  assert.ok(said, "without this the chat view shows tool calls and nothing else");
  assert.match(said.text, /token expiry/);
});

await test("the transcript wins over the hook timeline when both exist", async () => {
  const { socket } = freshWorld();
  const tp = writeTranscript("t2.jsonl", [
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "from the transcript" }] } },
  ]);
  deliverHook({ event: "SessionStart", providerSessionId: "p1", cwd: "/w", transcriptPath: tp });
  deliverHook({ event: "PreToolUse", toolName: "Read", toolInput: { file_path: "/a" } });

  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(res.source, "transcript");
  assert.ok(res.activity.some((r) => r.kind === "assistantText"));
});

await test("a session whose transcript has not been written yet still shows tool calls", async () => {
  const { socket } = freshWorld();
  deliverHook({ event: "SessionStart", providerSessionId: "p1", cwd: "/w", transcriptPath: path.join(tmp, "not-yet.jsonl") });
  deliverHook({ event: "PreToolUse", toolName: "Read", toolInput: { file_path: "/a" } });

  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.equal(res.source, "hooks", "a new session takes seconds to flush its first line");
  assert.equal(res.activity.length, 1);
});

await test("newly written prose appears on the next subscribe", async () => {
  const { socket } = freshWorld();
  const tp = writeTranscript("t3.jsonl", [
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
  ]);
  deliverHook({ event: "SessionStart", providerSessionId: "p1", cwd: "/w", transcriptPath: tp });
  await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });

  fs.appendFileSync(tp, JSON.stringify({ type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "second" }] } }) + "\n");
  const res = await socket.fire(EVENTS.SUBSCRIBE, { sessionId: PTY_SESSION });
  assert.deepEqual(res.activity.filter((r) => r.kind === "assistantText").map((r) => r.text), ["first", "second"]);
});

await test("Stop tells clients to re-read — that is when the closing prose lands", () => {
  freshWorld();
  const res = deliverHook({ event: "Stop" });
  assert.equal(res.activityChanged, true, "Stop adds no row, but the transcript changed underneath");
});

/* ================= session mapping details that make resume work ================= */

await test("the mapping keeps the cwd the CLI started in, not where the user cd'd to", async () => {
  freshWorld();
  deliverHook({ event: "SessionStart", providerSessionId: "p1", cwd: "/work/proj" });
  deliverHook({ event: "PreToolUse", toolName: "Bash", toolInput: { command: "cd /tmp" }, cwd: "/tmp" });
  assert.equal(sessionMap.getMapping(PTY_SESSION).startCwd, "/work/proj");
});

await test("the transcript path is stored verbatim", async () => {
  freshWorld();
  deliverHook({ event: "SessionStart", providerSessionId: "aaa-111", transcriptPath: "/p/bbb-222.jsonl", cwd: "/w" });
  assert.equal(sessionMap.getMapping(PTY_SESSION).transcriptPath, "/p/bbb-222.jsonl");
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
