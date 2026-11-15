// Single-lane scheduling for the AI pane's recovery work (web/features/ai/lib/singleLane.js).
// Contract: one debounced door, one in-flight op, a coalesced pending intent — triggers
// never stack rounds and never lose the last ask.
//
// Run: node --import ./test/loader-alias.mjs web/test/singleLane.test.mjs
import assert from "node:assert/strict";
import { createSingleLane } from "../features/ai/lib/singleLane.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
};

// Deterministic clock: tasks fire in schedule order at their scheduled time.
function fakeClock() {
  const tasks = new Map();
  let nextId = 1;
  let now = 0;
  return {
    schedule(fn, ms) { const id = nextId++; tasks.set(id, { fn, at: now + ms, id }); return id; },
    clear(id) { tasks.delete(id); },
    tick(ms) {
      now += ms;
      const due = [...tasks.values()].filter((t) => t.at <= now).sort((a, b) => a.id - b.id);
      for (const t of due) if (tasks.delete(t.id)) t.fn();
    }
  };
}

function makeLane(clock) {
  const runs = [];
  const lane = createSingleLane({
    run: (intent, done) => runs.push({ intent, done }),
    schedule: clock.schedule,
    clear: clock.clear,
    debounceMs: 150
  });
  return { lane, runs };
}

console.log("Running singleLane tests...");

test("a burst of requests coalesces into one run", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover");
  lane.request("recover");
  lane.request("recover");
  clock.tick(149);
  assert.equal(runs.length, 0, "fired before the debounce");
  clock.tick(1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].intent, "recover");
});

test("a request landing mid-run is coalesced into exactly one follow-up", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover");
  clock.tick(150);
  assert.equal(runs.length, 1);
  lane.request("gap");   // probe in flight
  lane.request("gap");   // same intent again — still one follow-up
  runs[0].done();
  clock.tick(150);
  assert.equal(runs.length, 2, "the follow-up ran");
  runs[1].done();
  clock.tick(500);
  assert.equal(runs.length, 2, "no extra round appeared");
});

test("the pending slot keeps the higher-priority intent", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover");
  clock.tick(150);
  lane.request("gap");
  lane.request("hydrate");
  runs[0].done();
  clock.tick(150);
  assert.equal(runs[1].intent, "hydrate", "a full hydrate subsumes a gap fill");
});

test("the pending slot never downgrades an already-waiting intent", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover");
  clock.tick(150);
  lane.request("hydrate");
  lane.request("gap");
  runs[0].done();
  clock.tick(150);
  assert.equal(runs[1].intent, "hydrate");
});

test("immediate runs at once when the lane is idle", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("now", { immediate: true });
  assert.equal(runs.length, 1, "no debounce on an immediate ask");
  clock.tick(500);
  assert.equal(runs.length, 1);
});

test("immediate while armed fires the armed intent, upgraded, without the debounce", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover");
  lane.request("now", { immediate: true });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].intent, "now", "the stronger intent wins the slot");
  clock.tick(500);
  assert.equal(runs.length, 1, "the disarmed timer never fired");
});

test("immediate mid-run drains the pending follow-up without a debounce", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover");
  clock.tick(150);
  lane.request("hydrate", { immediate: true });
  runs[0].done();
  assert.equal(runs.length, 2, "the follow-up ran in the same tick");
  assert.equal(runs[1].intent, "hydrate");
});

test("a custom delay is honored when arming", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("hydrate", { delayMs: 1200 });
  clock.tick(150);
  assert.equal(runs.length, 0);
  clock.tick(1050);
  assert.equal(runs.length, 1);
});

test("a double settle is ignored", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("gap");
  clock.tick(150);
  lane.request("gap");
  runs[0].done();
  runs[0].done();   // late settle — must not queue a second follow-up
  clock.tick(150);
  assert.equal(runs.length, 2);
  runs[1].done();
  clock.tick(500);
  assert.equal(runs.length, 2);
});

test("reset drops the armed timer and the pending intent", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover");
  lane.reset();
  clock.tick(500);
  assert.equal(runs.length, 0);
  lane.request("gap");   // reusable after a reset
  clock.tick(150);
  assert.equal(runs.length, 1);
});

test("a settle after reset is a no-op", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover", { immediate: true });
  lane.reset();
  runs[0].done();
  clock.tick(500);
  assert.equal(runs.length, 1, "no follow-up was armed for a lane that no longer runs");
});

test("a synchronous runner still coalesces correctly", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover", { immediate: true });   // runner settles synchronously via done()
  runs[0].done();                                  // the recorded done, called by the runner itself
  assert.equal(runs.length, 1);
  lane.request("gap");
  clock.tick(150);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].intent, "gap");
});

test("clearPending drops the armed ask without touching an in-flight run", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("hydrate", { delayMs: 1200 });
  lane.clearPending();
  clock.tick(2000);
  assert.equal(runs.length, 0, "the armed ask never fired");
  lane.request("recover");
  clock.tick(150);
  lane.request("gap");                 // pending while a run is in flight
  lane.clearPending();                 // an ack landed — the re-ask is no longer wanted
  runs[0].done();
  clock.tick(500);
  assert.equal(runs.length, 1, "the pending follow-up was dropped, the run itself untouched");
});

test("clearPending(kind) leaves other intents alone", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("recover");
  clock.tick(150);
  lane.request("gap");                 // a gap found mid-probe must survive a hydrate ack
  lane.clearPending("hydrate");
  runs[0].done();
  clock.tick(150);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].intent, "gap", "only the named intent is dropped");
});

test("a fresh gap pulls an armed long hydrate retry earlier", () => {
  const clock = fakeClock();
  const { lane, runs } = makeLane(clock);
  lane.request("hydrate", { delayMs: 6000 });   // ladder rung waiting
  lane.request("gap");                           // a hole appeared right now
  clock.tick(150);
  assert.equal(runs.length, 1, "the ask must not wait out six seconds");
  assert.equal(runs[0].intent, "hydrate", "the stronger intent keeps the slot");
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
