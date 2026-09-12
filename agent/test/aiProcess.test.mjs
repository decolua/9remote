// Tests for AI Process Managers & Normalization
// Run: node agent/test/aiProcess.test.mjs
import assert from "node:assert/strict";
import { AiManager } from "../features/ai/aiManager.js";
import { AI_ENGINES, AI_TURN_IDLE_TIMEOUT_MS } from "../features/ai/constants.js";
import { touchOutput, forgetSession } from "../features/terminal/statusManager.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

console.log("Running AI Process Manager tests...");

await test("AI_ENGINES contains claude, codex, and opencode", () => {
  assert.equal(AI_ENGINES.CLAUDE, "claude");
  assert.equal(AI_ENGINES.CODEX, "codex");
  assert.equal(AI_ENGINES.OPENCODE, "opencode");
});

await test("AiManager creates and retrieves session", () => {
  const manager = new AiManager();
  const session = manager.createSession("test-session-1", AI_ENGINES.CLAUDE, "/tmp", { mock: true });
  assert.equal(session.id, "test-session-1");
  assert.equal(session.engine, "claude");
  assert.equal(session.cwd, "/tmp");
  assert.equal(manager.getSession("test-session-1"), session);
});

await test("AiManager rejects invalid engine", () => {
  const manager = new AiManager();
  assert.throws(() => {
    manager.createSession("invalid-sess", "unknown-engine", "/tmp", { mock: true });
  }, /Invalid AI engine/);
});

await test("AiManager lists active sessions", () => {
  const manager = new AiManager();
  manager.createSession("s1", AI_ENGINES.CLAUDE, "/tmp", { mock: true });
  manager.createSession("s2", AI_ENGINES.CODEX, "/tmp", { mock: true });
  const list = manager.listSessions();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(s => s.id).sort(), ["s1", "s2"]);
});

await test("AiManager destroys session cleanly", () => {
  const manager = new AiManager();
  manager.createSession("s1", AI_ENGINES.OPENCODE, "/tmp", { mock: true });
  assert.ok(manager.getSession("s1"));
  manager.destroySession("s1");
  assert.equal(manager.getSession("s1"), undefined);
});

await test("AiManager broadcast event listener receives engine events", (t) => {
  const manager = new AiManager();
  const received = [];
  manager.onEvent((sessionId, event, data) => {
    received.push({ sessionId, event, data });
  });

  const session = manager.createSession("s-event", AI_ENGINES.CLAUDE, "/tmp", { mock: true });
  session.emitNormalized("delta", { text: "Hello" });

  assert.equal(received.length, 1);
  assert.equal(received[0].sessionId, "s-event");
  assert.equal(received[0].event, "delta");
  assert.equal(received[0].data.text, "Hello");
});

// ── Turn watchdog vs. a terminal that is still streaming ──
// The turn's clock is measured from the last sign of life at all: a chat CLI that has
// gone quiet while the terminal sharing its session keeps printing (a long build) is
// working, so the watchdog reschedules for the remainder instead of killing the turn.

// Mock mode skips the adapter, so no real CLI is spawned; the watchdog still runs.
const startTurn = (id) => {
  const session = new AiManager().createSession(id, AI_ENGINES.CODEX, "/tmp", { mock: true });
  session.isTurnRunning = true;
  return session;
};

// The watchdog reschedules itself off the same clock, so the test drives setTimeout
// instead of waiting out the window: collect what was scheduled, then fire it.
const withCapturedTimers = (fn) => {
  const real = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return { unref() {} }; };
  try { return fn(timers); } finally { globalThis.setTimeout = real; }
};

// The watchdog compares against Date.now(); freeze it so a minute of streaming costs
// no test time.
const withFrozenClock = (fn) => {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try { return fn((ms) => { now += ms; }); } finally { Date.now = real; }
};

await test("a quiet turn is killed once nothing has been heard for the whole window", async () => {
  const session = startTurn("s-watchdog-idle");
  try {
    withCapturedTimers((timers) => {
      session.armIdleWatchdog();
      assert.equal(timers.length, 1);
      assert.equal(timers[0].ms, AI_TURN_IDLE_TIMEOUT_MS);
      timers[0].cb();
    });
    assert.equal(session.isTurnRunning, false, "the turn should have been stopped");
  } finally { session.destroy(); }
});

await test("a streaming terminal reschedules the watchdog instead of ending the turn", async () => {
  const session = startTurn("s-watchdog-streaming");
  try {
    withCapturedTimers((timers) => {
      withFrozenClock((tick) => {
        touchOutput("s-watchdog-streaming");
        session.armIdleWatchdog();
        timers[0].cb(); // the whole window elapses, but the terminal is still printing
        assert.equal(session.isTurnRunning, true, "the turn must survive");
        assert.equal(timers.length, 2, "the watchdog must be re-armed");
        assert.equal(timers[1].ms, AI_TURN_IDLE_TIMEOUT_MS, "and given a fresh window");
        tick(30_000); // it keeps printing, so an event-less stretch can never kill it
        timers[1].cb();
        assert.equal(session.isTurnRunning, true, "still printing, still working");
        assert.equal(timers.length, 3);
      });
    });
  } finally { session.destroy(); forgetSession("s-watchdog-streaming"); }
});

await test("a terminal that streamed and then stopped still lets the turn time out", async () => {
  const session = startTurn("s-watchdog-gap");
  try {
    withCapturedTimers((timers) => {
      withFrozenClock((tick) => {
        touchOutput("s-watchdog-gap");
        session.armIdleWatchdog();
        tick(60_000); // printed for a minute, then went quiet
        timers[0].cb();
        assert.equal(session.isTurnRunning, true, "a minute of silence is not the whole window yet");
        assert.equal(timers.length, 2, "the watchdog must survive to the end of the window");
        tick(60_000); // now nothing at all has been heard for two minutes
        timers[1].cb();
        assert.equal(session.isTurnRunning, false, "the turn must be stopped");
      });
    });
  } finally { session.destroy(); forgetSession("s-watchdog-gap"); }
});

if (fail > 0) {
  console.error(`\nTests failed: ${fail}/${pass + fail}`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed: ${pass}/${pass}`);
}
