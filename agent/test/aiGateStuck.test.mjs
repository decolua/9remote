// The three ways a permission/question gate used to wedge a chat, each pinned here.
//
// Run: node agent/test/aiGateStuck.test.mjs
//
// 1. The idle watchdog SIGINT'd the CLI while it was waiting on a gate — the card stayed
//    on screen, taps did nothing, and the turn died two minutes later.
// 2. An answer for a request id the CLI had already dropped was written to the pipe and
//    reported as success, so the client cleared its card over a reply nobody received.
// 3. A gate whose permission_request had scrolled out of the replay tail was invisible
//    after a reload while the CLI went on waiting forever.

import assert from "node:assert/strict";
import { setupAiHandlers } from "../features/ai/aiSocket.js";
import { AiManager } from "../features/ai/aiManager.js";
import { AI_SOCKET_EVENTS, AI_ENGINES } from "../features/ai/constants.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

class MockSocket {
  constructor() { this.handlers = new Map(); }
  on(event, handler) { this.handlers.set(event, handler); }
  emit() {}
  trigger(event, data) {
    return new Promise((resolve) => this.handlers.get(event)(data, resolve));
  }
}

class MockBus { broadcast() {} }

class FakeProc {
  constructor() { this.written = []; }
  async start() { return { lines: [], from: 0 }; }
  write(text) { this.written.push(text); }
  async stop() { this.stopped = true; }
}

async function claudeSession(manager, id) {
  const session = manager.createSession(id, AI_ENGINES.CLAUDE, "/tmp", { mock: true });
  const proc = new FakeProc();
  session.adapter = {
    pendingRequests: new Map(),
    stats: null,
    stop: async () => { proc.stopped = true; },
    resolveQuestion(requestId, answers) {
      const pending = this.pendingRequests.get(requestId);
      this.pendingRequests.delete(requestId);
      if (!pending) return false;
      proc.write(JSON.stringify({ requestId, answers }));
      return true;
    }
  };
  return { session, proc };
}

await test("watchdog stands down while a gate is open", async () => {
  const manager = new AiManager();
  const { session, proc } = await claudeSession(manager, "gate-watchdog");
  session.isTurnRunning = true;
  session.adapter.pendingRequests.set("req-1", { toolName: "AskUserQuestion", input: {} });

  // Fire the timer for real: with the gate held, the guard returns before it can decide
  // the CLI stalled, so no SIGINT reaches a process that is only waiting on the user.
  session.armIdleWatchdog(5);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(proc.stopped, undefined, "the CLI was killed out from under the card");

  // The gate closed → the watchdog is free to judge silence again.
  session.adapter.pendingRequests.delete("req-1");
  session.armIdleWatchdog(5);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(proc.stopped, true, "a genuinely silent turn must still be stopped");
});

await test("an answer for a dropped request is refused, not written", async () => {
  const socket = new MockSocket();
  const manager = new AiManager();
  setupAiHandlers(socket, new MockBus(), manager);
  const { session, proc } = await claudeSession(manager, "gate-stale");

  // Nothing is pending on the CLI side — the id it is being answered with is dead.
  const res = await socket.trigger(AI_SOCKET_EVENTS.QUESTION, {
    sessionId: session.id, requestId: "req-gone", answers: { Q: "A" }
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "stale");
  assert.equal(proc.written.length, 0, "no stray control_response on the pipe");
  assert.equal(session.pendingPermission(), null);
});

await test("a live gate is answered and the card is cleared", async () => {
  const socket = new MockSocket();
  const manager = new AiManager();
  setupAiHandlers(socket, new MockBus(), manager);
  const { session, proc } = await claudeSession(manager, "gate-live");
  session.adapter.pendingRequests.set("req-2", { toolName: "AskUserQuestion", input: { questions: [] } });

  const res = await socket.trigger(AI_SOCKET_EVENTS.QUESTION, {
    sessionId: session.id, requestId: "req-2", answers: { Q: "A" }
  });

  assert.equal(res.ok, true);
  assert.equal(proc.written.length, 1);
  assert.equal(session.pendingPermission(), null, "the gate is gone once it is answered");
});

await test("a gate missing from the replay is still reported to a hydrating client", async () => {
  const socket = new MockSocket();
  const manager = new AiManager();
  setupAiHandlers(socket, new MockBus(), manager);
  const { session } = await claudeSession(manager, "gate-replay");
  // The request event is long gone from the log; only the adapter still holds the gate.
  session.adapter.pendingRequests.set("req-3", {
    toolName: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [] }] }
  });

  const res = await socket.trigger(AI_SOCKET_EVENTS.CREATE, {
    sessionId: session.id, engine: AI_ENGINES.CLAUDE, cwd: "/tmp"
  });

  assert.equal(res.session.activePermission?.requestId, "req-3");
  assert.equal(res.session.activePermission?.tool, "AskUserQuestion");
});

await test("pendingPermission is null on an engine that holds no gate", async () => {
  const manager = new AiManager();
  const session = manager.createSession("gate-none", AI_ENGINES.OPENCODE, "/tmp", { mock: true });
  assert.equal(session.pendingPermission(), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
