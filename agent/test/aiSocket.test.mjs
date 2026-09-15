// Tests for AI Socket Protocol Handlers
// Run: node agent/test/aiSocket.test.mjs
import assert from "node:assert/strict";
import { setupAiHandlers } from "../features/ai/aiSocket.js";
import { AiManager } from "../features/ai/aiManager.js";
import { AI_ENGINES } from "../features/ai/constants.js";

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

await test("setupAiHandlers registers all required socket events", () => {
  const socket = new MockSocket();
  const bus = new MockBus();
  const manager = new AiManager();

  setupAiHandlers(socket, bus, manager);

  assert.ok(socket.handlers.has("ai:create"));
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

// An unrecorded event is not in the log the client watermark is compared against —
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

if (fail > 0) {
  console.error(`\nTests failed: ${fail}/${pass + fail}`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed: ${pass}/${pass}`);
}
