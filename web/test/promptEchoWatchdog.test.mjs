// An ack only proves the host accepted the prompt; the turn is alive when its
// user_message comes back. A host that acks and then goes quiet left the chat
// blank with no way to retry — this watchdog turns that silence into a Resend.
// Run: node --import ./test/loader-alias.mjs test/promptEchoWatchdog.test.mjs
import assert from "node:assert/strict";
import { createEchoWatchdog } from "../features/ai/lib/echoWatchdog.js";

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

const TIMEOUT = 10_000;

test("an echo that never arrives surfaces once", () => {
  const clock = fakeClock();
  let missing = 0;
  const watch = createEchoWatchdog({
    timeoutMs: TIMEOUT, schedule: clock.schedule, clear: clock.clear,
    onMissing: () => missing++
  });
  watch.arm();
  clock.advance(TIMEOUT);
  assert.equal(missing, 1);
  clock.advance(TIMEOUT * 2);
  assert.equal(missing, 1, "settle-once: no repeat firing");
});

test("a user_message before the deadline cancels it", () => {
  const clock = fakeClock();
  let missing = 0;
  const watch = createEchoWatchdog({
    timeoutMs: TIMEOUT, schedule: clock.schedule, clear: clock.clear,
    onMissing: () => missing++
  });
  watch.arm();
  watch.settle();
  clock.advance(TIMEOUT * 2);
  assert.equal(missing, 0);
  assert.equal(clock.pending(), 0, "the timer is cleared, not merely ignored");
});

test("arming twice keeps one timer", () => {
  const clock = fakeClock();
  let missing = 0;
  const watch = createEchoWatchdog({
    timeoutMs: TIMEOUT, schedule: clock.schedule, clear: clock.clear,
    onMissing: () => missing++
  });
  watch.arm();
  watch.arm();
  assert.equal(clock.pending(), 1);
  clock.advance(TIMEOUT);
  assert.equal(missing, 1);
});

test("settling after the fire changes nothing", () => {
  const clock = fakeClock();
  let missing = 0;
  const watch = createEchoWatchdog({
    timeoutMs: TIMEOUT, schedule: clock.schedule, clear: clock.clear,
    onMissing: () => missing++
  });
  watch.arm();
  clock.advance(TIMEOUT);
  watch.settle();
  assert.equal(missing, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
