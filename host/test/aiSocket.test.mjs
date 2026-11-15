// Tests for AI Socket Protocol Handlers
// Run: node agent/test/aiSocket.test.mjs
import assert from "node:assert/strict";
import { setupAiHandlers } from "../features/ai/aiSocket.js";
import { AiManager } from "../features/ai/aiManager.js";
import { AI_ENGINES } from "../features/ai/constants.js";
import { applyEvent, getStatus, forgetSession, flushDoneCommits } from "../features/terminal/statusManager.js";
import { setupTerminalSocket } from "../features/terminal/terminalSocket.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

console.log("Running AI Socket Handler tests...");

class MockSocket {
  constructor() {
    this.handlers = new Map();
    this.emitted = [];
  }
  on(event, handler) {
    this.handlers.set(event, handler);
  }
  emit(event, data) {
    this.emitted.push({ event, data });
  }
  trigger(event, data) {
    return new Promise((resolve) => {
      const handler = this.handlers.get(event);
      if (!handler) return resolve({ error: "no_handler" });
      handler(data, (res) => resolve(res));
    });
  }
}

class MockBus {
  constructor() {
    this.broadcasts = [];
  }
  broadcast(event, data) {
    this.broadcasts.push({ event, data });
  }
}

// The manager whose onEvent mirror is live. setupAiHandlers wires it once per process
// (broadcastAttached is module-level), so later tests must reuse this one, not a fresh one.
let wiredManager = null;

await test("setupAiHandlers registers all required socket events", () => {
  const socket = new MockSocket();
  const bus = new MockBus();
  const manager = new AiManager();
  wiredManager = manager;

  setupAiHandlers(socket, bus, manager);

  assert.ok(socket.handlers.has("ai:create"));
  assert.ok(socket.handlers.has("ai:peekSeq"));
  assert.ok(socket.handlers.has("ai:prompt"));
  assert.ok(socket.handlers.has("ai:permission"));
  assert.ok(socket.handlers.has("ai:question"));
  assert.ok(socket.handlers.has("ai:stop"));
  assert.ok(socket.handlers.has("ai:options"));
  assert.ok(socket.handlers.has("ai:destroy"));
  assert.ok(socket.handlers.has("ai:list"));
});

await test("ai:create socket message initializes session and returns metadata", async () => {
  const socket = new MockSocket();
  const bus = new MockBus();
  const manager = new AiManager();
  setupAiHandlers(socket, bus, manager);

  const res = await socket.trigger("ai:create", {
    sessionId: "sock-s1",
    engine: AI_ENGINES.CLAUDE,
    cwd: "/tmp",
    mock: true
  });

  assert.equal(res.ok, true);
  assert.equal(res.sessionId, "sock-s1");
  assert.equal(res.engine, "claude");
  assert.ok(manager.getSession("sock-s1"));

  const peek = await socket.trigger("ai:peekSeq", { sessionId: "sock-s1" });
  assert.equal(peek.ok, true);
  assert.equal(typeof peek.seq, "number");
  assert.equal(typeof peek.isTurnRunning, "boolean");

  const peekMissing = await socket.trigger("ai:peekSeq", { sessionId: "non-existent" });
  assert.equal(peekMissing.ok, false);
});

await test("ai:prompt socket message dispatches to engine", async () => {
  const socket = new MockSocket();
  const bus = new MockBus();
  const manager = new AiManager();
  setupAiHandlers(socket, bus, manager);

  await socket.trigger("ai:create", {
    sessionId: "sock-s2",
    engine: AI_ENGINES.CODEX,
    cwd: "/tmp",
    mock: true
  });

  const res = await socket.trigger("ai:prompt", {
    sessionId: "sock-s2",
    message: "Fix bug in foo.js"
  });

  assert.equal(res.ok, true);
  const session = manager.getSession("sock-s2");
  assert.equal(session.lastPrompt, "Fix bug in foo.js");
});

await test("session events are broadcasted via bus with ai:event", async () => {
  const socket = new MockSocket();
  const bus = new MockBus();
  const manager = new AiManager();
  setupAiHandlers(socket, bus, manager);

  await socket.trigger("ai:create", {
    sessionId: "sock-s3",
    engine: AI_ENGINES.OPENCODE,
    cwd: "/tmp",
    mock: true
  });

  const session = manager.getSession("sock-s3");
  session.emitNormalized("delta", { text: "processing..." });

  const deltaEvent = socket.emitted.find((e) => e.data?.event === "delta");
  assert.ok(deltaEvent);
  assert.equal(deltaEvent.event, "ai:event");
  assert.equal(deltaEvent.data.sessionId, "sock-s3");
  assert.equal(deltaEvent.data.data.text, "processing...");
});

await test("a chat session's own events push the working TTL out (no PTY does it for it)", () => {
  const id = "ttl-chat";
  applyEvent({ type: "working", sessionId: id, tool: "claude" });
  // Backdate the entry to where the reaper is about to take it.
  getStatus(id).expiresAt = Date.now() - 1;
  // Events naming no status are the bulk of a long turn — they must still count as the
  // CLI being alive, or the reaper blanks a running turn 60s in with the dot going idle.
  wiredManager.broadcastEvent(id, "stats", {});
  assert.ok(getStatus(id).expiresAt > Date.now(), "TTL was not pushed out");
  forgetSession(id);
});

await test("a replayed event does not move the status dot", () => {
  // Every F5 rebuilds the log from the transcript and re-sends it, and a rebuilt log ends
  // on a turn_complete. Mirrored, that painted the tab's dot amber while the turn was
  // still streaming, until the next live event (a tool call) moved it back to blue.
  //
  // The mirror reaches statusManager through broadcastAiStatus, which no-ops until the
  // terminal side has wired its io — so wire it here or the assert passes for the wrong
  // reason (nothing would be applied at all).
  setupTerminalSocket({ sockets: { sockets: new Map() } }, "test-key");
  const id = "replay-dot";
  applyEvent({ type: "working", sessionId: id, tool: "claude" });
  wiredManager.broadcastEvent(id, "turn_complete", { replay: true });
  assert.equal(getStatus(id).state, "working", "history is not news");
  // ...while a live turn_complete still ends the turn — after the done debounce,
  // flushed here rather than waited out.
  wiredManager.broadcastEvent(id, "turn_complete", {});
  flushDoneCommits();
  assert.equal(getStatus(id).state, "done");
  forgetSession(id);
});

// Without the seq the client cannot tell an event it already replayed from a new one, and
// renders the same prompt twice — the live copy plus the one the hydrate replayed.
await test("a recorded event carries its log seq to the client", () => {
  const socket = new MockSocket();
  const bus = new MockBus();
  const manager = new AiManager();
  setupAiHandlers(socket, bus, manager);
  const session = manager.createSession("seq-s1", AI_ENGINES.CLAUDE, "/tmp", { mock: true });

  session.emitNormalized("delta", { text: "one" });
  session.emitNormalized("delta", { text: "two" });
  const seqs = socket.emitted.map((e) => e.data?.seq);
  assert.deepEqual(seqs, [1, 2]);
  assert.equal(session.history.at(-1).seq, seqs.at(-1));
});

// Without the epoch a renumbered log's echo reads as "already applied" on the client and
// the prompt the user just sent vanishes; it must survive the AiManager hop.
await test("a live event carries its log epoch through the manager", () => {
  const socket = new MockSocket();
  const bus = new MockBus();
  const manager = new AiManager();
  setupAiHandlers(socket, bus, manager);
  const session = manager.createSession("epoch-s1", AI_ENGINES.CLAUDE, "/tmp", { mock: true });

  session.emitNormalized("delta", { text: "one" });
  assert.equal(socket.emitted.at(-1).data.epoch, session.logEpoch);
  assert.ok(session.logEpoch != null);
});

// A Resend after a lost ack carries the same promptId; the host already ran it once.
await test("a repeated promptId is acked but not run twice", async () => {
  const socket = new MockSocket();
  const bus = new MockBus();
  const manager = new AiManager();
  setupAiHandlers(socket, bus, manager);
  manager.createSession("dedupe-s1", AI_ENGINES.CLAUDE, "/tmp", { mock: true });

  const first = await socket.trigger("ai:prompt", { sessionId: "dedupe-s1", message: "hi", promptId: "p-1" });
  const again = await socket.trigger("ai:prompt", { sessionId: "dedupe-s1", message: "hi", promptId: "p-1" });
  const echoes = socket.emitted.filter((e) => e.data?.event === "user_message");
  assert.equal(first?.ok, true);
  assert.equal(again?.ok, true);
  assert.equal(again?.repeat, true);
  assert.equal(echoes.length, 1, "the turn ran once");
});

// An unrecorded event is not in the log the client's watermark is compared against —
// stamping it would leave the watermark past the snapshot, and the next hydrate would
// swallow every event up to that number.
await test("an event kept out of the log carries no seq", () => {
  const socket = new MockSocket();
  const bus = new MockBus();
  const manager = new AiManager();
  setupAiHandlers(socket, bus, manager);
  const session = manager.createSession("seq-s2", AI_ENGINES.CLAUDE, "/tmp", { mock: true });

  session.emitNormalized("init", { model: "m" }, false);
  assert.equal(socket.emitted.at(-1).data.seq, undefined);
});

// A manager stub hands the test the event listener the socket layer installs, so a
// late CLI failure can be replayed exactly as the real adapter emits it.
function stubManager(session) {
  const listeners = [];
  return {
    listeners,
    onEvent(fn) { listeners.push(fn); return () => {}; },
    getSession: () => session,
    createSession: () => session
  };
}

await test("a repeat whose prompt never ran is accepted again", async () => {
  // The adapter refused before any user_message existed (dead CLI, write rejected).
  // The id was recorded, so a Resend used to be acked "repeat" and ignored forever.
  const socket = new MockSocket();
  const manager = stubManager(null);
  const calls = [];
  const session = {
    history: [],
    isTurnRunning: false,
    ensureProcAlive: async () => {},
    sendPrompt: (text, attachments, promptId) => {
      calls.push(text);
      if (calls.length > 1) return; // the resend reaches a recovered CLI
      for (const l of manager.listeners) l("refuse-s1", "prompt_refused", { text, promptId, reason: "not writable" }, undefined, "e1");
      return { refused: true, error: "not writable" };
    }
  };
  manager.getSession = () => session;
  setupAiHandlers(socket, new MockBus(), manager);

  const first = await socket.trigger("ai:prompt", { sessionId: "refuse-s1", message: "hi", promptId: "p-refuse" });
  const again = await socket.trigger("ai:prompt", { sessionId: "refuse-s1", message: "hi", promptId: "p-refuse" });

  assert.equal(first?.ok, false, "a prompt no turn accepted must not ack ok");
  assert.match(first?.error, /not writable/);
  assert.equal(again?.ok, true);
  assert.equal(again?.repeat, undefined, "a prompt that never ran must not be acked as a repeat");
  assert.equal(calls.length, 2, "the resend reaches the adapter again");
});

await test("a repeat whose late write failure was reported is accepted again", async () => {
  // Daemon write failures arrive after the ack: the adapter emits an error carrying
  // the promptId. The id must be released, or the user's Resend is silently dropped.
  const socket = new MockSocket();
  const manager = stubManager(null);
  const calls = [];
  const session = {
    history: [],
    isTurnRunning: false,
    ensureProcAlive: async () => {},
    sendPrompt: (text) => { calls.push(text); }
  };
  manager.getSession = () => session;
  setupAiHandlers(socket, new MockBus(), manager);

  await socket.trigger("ai:prompt", { sessionId: "refuse-s2", message: "hi", promptId: "p-late" });
  for (const l of manager.listeners) {
    l("refuse-s2", "error", { message: "The CLI did not accept the prompt", promptId: "p-late" }, undefined, "e2");
  }
  const again = await socket.trigger("ai:prompt", { sessionId: "refuse-s2", message: "hi", promptId: "p-late" });

  assert.equal(again?.repeat, undefined);
  assert.equal(calls.length, 2);
});

await test("a repeat after the turn ran is still acked without running twice", async () => {
  const socket = new MockSocket();
  const manager = stubManager(null);
  const calls = [];
  const session = {
    history: [{ event: "user_message", data: { text: "hi" } }],
    isTurnRunning: false,
    ensureProcAlive: async () => {},
    sendPrompt: (text) => { calls.push(text); }
  };
  manager.getSession = () => session;
  setupAiHandlers(socket, new MockBus(), manager);

  await socket.trigger("ai:prompt", { sessionId: "ran-s1", message: "hi", promptId: "p-ran" });
  const again = await socket.trigger("ai:prompt", { sessionId: "ran-s1", message: "hi", promptId: "p-ran" });

  assert.equal(again?.repeat, true);
  assert.equal(calls.length, 1);
});

await test("a repeat while the first prompt is queued mid-turn is not run twice", async () => {
  // Still in flight (CLI booting or turn running): no user_message yet, but running
  // must win — re-running here would answer the same prompt twice.
  const socket = new MockSocket();
  const manager = stubManager(null);
  const calls = [];
  const session = {
    history: [],
    isTurnRunning: false,
    ensureProcAlive: async () => {},
    sendPrompt: (text) => { calls.push(text); session.isTurnRunning = true; }
  };
  manager.getSession = () => session;
  setupAiHandlers(socket, new MockBus(), manager);

  await socket.trigger("ai:prompt", { sessionId: "run-s1", message: "hi", promptId: "p-run" });
  const again = await socket.trigger("ai:prompt", { sessionId: "run-s1", message: "hi", promptId: "p-run" });

  assert.equal(again?.repeat, true);
  assert.equal(calls.length, 1);
});

if (fail > 0) {
  console.error(`\nTests failed: ${fail}/${pass + fail}`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed: ${pass}/${pass}`);
}
