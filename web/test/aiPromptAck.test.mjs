// A prompt emitted into a dead-but-not-closed carrier never errors and never
// callbacks — the text the user typed vanishes with zero feedback (#48). The host
// already answers ai:prompt with cb({ok,queued|error}); this is the client-side
// settle-once + self-timeout wrapper so a lost prompt surfaces as a resendable error.
// Run: node --import ./test/loader-alias.mjs web/test/aiPromptAck.test.mjs
import assert from "node:assert/strict";
import { emitPromptAck } from "../features/ai/lib/promptAck.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const fakeClock = () => {
  const timers = new Map();
  let now = 0, seq = 0;
  return {
    schedule: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clear: (id) => timers.delete(id),
    advance: (ms) => {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size
  };
};

const TIMEOUT = 8000;

test("ack ok settles clean: no error, timer cleared", () => {
  const clock = fakeClock();
  const lost = [];
  let ack = null;
  emitPromptAck(
    (payload, done) => { ack = done; },
    { message: "hi" },
    TIMEOUT,
    (reason) => lost.push(reason),
    clock.schedule, clock.clear
  );
  ack({ ok: true, queued: false });
  clock.advance(TIMEOUT * 2);
  assert.deepEqual(lost, []);
  assert.equal(clock.pending(), 0, "timer must be cleared on settle");
});

test("no ack before the timeout surfaces the loss once", () => {
  const clock = fakeClock();
  const lost = [];
  emitPromptAck(
    (payload, done) => { /* dead carrier: nothing ever calls done */ },
    { message: "hi" },
    TIMEOUT,
    (reason) => lost.push(reason),
    clock.schedule, clock.clear
  );
  clock.advance(TIMEOUT);
  assert.deepEqual(lost, ["timeout"]);
  clock.advance(TIMEOUT);
  assert.equal(lost.length, 1, "settle-once: no repeat firing");
});

test("host refusal surfaces its error message", () => {
  const clock = fakeClock();
  const lost = [];
  let ack = null;
  emitPromptAck(
    (payload, done) => { ack = done; },
    { message: "hi" },
    TIMEOUT,
    (reason) => lost.push(reason),
    clock.schedule, clock.clear
  );
  ack({ ok: false, error: "AI session unavailable" });
  clock.advance(TIMEOUT * 2);
  assert.deepEqual(lost, ["AI session unavailable"]);
});

test("late ack after the timeout does not double-fire", () => {
  const clock = fakeClock();
  const lost = [];
  let ack = null;
  emitPromptAck(
    (payload, done) => { ack = done; },
    { message: "hi" },
    TIMEOUT,
    (reason) => lost.push(reason),
    clock.schedule, clock.clear
  );
  clock.advance(TIMEOUT);
  ack({ ok: true });
  assert.deepEqual(lost, ["timeout"], "already settled — the late ack changes nothing");
});

test("queued prompt is delivered, not lost", () => {
  const clock = fakeClock();
  const lost = [];
  let ack = null;
  emitPromptAck(
    (payload, done) => { ack = done; },
    { message: "hi" },
    TIMEOUT,
    (reason) => lost.push(reason),
    clock.schedule, clock.clear
  );
  ack({ ok: true, queued: true });
  clock.advance(TIMEOUT * 2);
  assert.deepEqual(lost, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
