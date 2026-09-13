// Tests for AI Process Managers & Normalization
// Run: node agent/test/aiProcess.test.mjs
import assert from "node:assert/strict";
import { AiManager } from "../features/ai/aiManager.js";
import { AgentProc } from "../features/ai/proc/agentProc.js";
import { DaemonProc } from "../features/ai/proc/daemonProc.js";
import { AI_ENGINES, AI_TURN_IDLE_TIMEOUT_MS } from "../features/ai/constants.js";
import { touchOutput, forgetSession } from "../features/terminal/statusManager.js";

// A stand-in daemon for the proc tests: the client is injected, so no daemon and no
// CLI are spawned. Lines are numbered and buffered the way the real one does, so a
// fetch can carry what a live event already delivered.
function makeProcClient(procId = "p-live", epoch = 1) {
  const handlers = new Map();
  const state = { epoch, count: 0, lines: [] };
  const emit = (event, payload) => {
    for (const h of handlers.get(event) || []) h(payload);
  };
  return {
    state,
    on: (event, h) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(h); },
    off: (event, h) => {
      const list = handlers.get(event) || [];
      const i = list.indexOf(h);
      if (i !== -1) list.splice(i, 1);
    },
    emitLine: (text) => {
      state.count++;
      state.lines.push({ n: state.count, enc: "b64", data: Buffer.from(text).toString("base64") });
      emit("procLine", { procId, epoch: state.epoch, n: state.count, data: text });
    },
    procStart: async () => ({ success: true, epoch: state.epoch, pid: 1 }),
    procLines: async (id, from) => ({
      success: true, epoch: state.epoch,
      lines: state.lines.filter((l) => l.n > from), total: state.count, oldest: state.lines[0]?.n ?? 1
    }),
    procAttach: async (id, from) => ({
      success: true, alive: true, epoch: state.epoch,
      lines: state.lines.filter((l) => l.n > from), total: state.count, oldest: state.lines[0]?.n ?? 1
    }),
    procEndInput: async () => ({ success: true }),
    procStop: async () => ({ success: true }),
  };
}

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

await test("a started turn's lines are delivered live, not held for a replay nobody asked for", async () => {
  // Turn-per-CLI engines (codex, opencode, agy) start a process per turn and parse the
  // result themselves — there is no fetch to replay. A release() the adapter never
  // calls would hold every line of the turn, which is a chat that streams nothing.
  const proc = new AgentProc({ procId: "p-live", client: makeProcClient() });
  const seen = [];
  proc.onLine = (line) => seen.push(line);

  await proc.start({ bin: "codex", cwd: "/tmp" });
  proc.client.emitLine("turn output");

  assert.deepEqual(seen, ["turn output"]);
});

await test("adopting a different process drops a watermark taken from the old one", async () => {
  // Claude keeps one proc id across turns, so a watermark outlives the process it was
  // measured against. Applied to a new process — which numbers from 1 again — it would
  // skip the head of the resumed conversation.
  const proc = new DaemonProc({ procId: "p-epoch", client: makeProcClient("p-epoch") });
  proc.onLine = () => {};
  await proc.start({ bin: "claude", cwd: "/tmp" });
  proc._lastLine = 7;
  proc._epoch = 1;

  // A new process under the same proc id: its numbers start at 1, so the stored
  // watermark must not survive into it.
  const other = makeProcClient("p-epoch", 2);
  other.emitLine("resumed head");
  proc.client = other;
  const fetch = await proc.attach(7, 1);
  fetch.release();

  assert.equal(proc.lineNo > 0, true, "the new process's lines must not be skipped");
});

if (fail > 0) {
  console.error(`\nTests failed: ${fail}/${pass + fail}`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed: ${pass}/${pass}`);
}
