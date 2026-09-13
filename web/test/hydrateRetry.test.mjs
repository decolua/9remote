// The re-ask ladder for an `ai:create` nobody answered. Contract: a dropped ack must not
// permanently cost the pane its history (and with it the load-older affordance), but a
// healthy host must never be asked twice.
//
// Run: node web/test/hydrateRetry.test.mjs
import assert from "node:assert/strict";
import { createRetryLadder, HYDRATE_RETRY_DELAYS_MS } from "../features/ai/lib/hydrateRetry.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running hydrateRetry tests...");

test("failures walk the ladder in order", () => {
  const l = createRetryLadder();
  assert.deepEqual(
    [l.schedule(true), l.fired(), l.schedule(true), l.fired(), l.schedule(true), l.fired(), l.schedule(true)].filter((x) => x !== undefined && x !== null),
    HYDRATE_RETRY_DELAYS_MS
  );
});

test("the ladder gives up instead of retrying forever", () => {
  const l = createRetryLadder([10, 20]);
  assert.equal(l.schedule(true), 10);
  l.fired();
  assert.equal(l.schedule(true), 20);
  l.fired();
  assert.equal(l.schedule(true), null);
  l.fired();
  assert.equal(l.schedule(true), null);
});

test("two failures before the timer fires do not consume two rungs", () => {
  const l = createRetryLadder([10, 20]);
  assert.equal(l.schedule(true), 10);
  assert.equal(l.schedule(true), null, "stacked a second timer on the same rung");
  l.fired();
  assert.equal(l.schedule(true), 20, "the stack guard ate the next rung");
});

test("any answer resets the ladder — a later outage starts over", () => {
  const l = createRetryLadder([10, 20]);
  l.schedule(true); l.fired();
  l.schedule(true); l.fired();
  l.answered();
  assert.equal(l.schedule(true), 10, "a fresh failure resumed mid-ladder");
});

test("an answer clears a pending retry too", () => {
  const l = createRetryLadder([10, 20]);
  assert.equal(l.schedule(true), 10);
  l.answered();
  // The caller cancels its timer on `answered`; the ladder must not still hold the rung.
  assert.equal(l.schedule(true), 10);
});

test("offline arms nothing — the bus connect trigger owns that recovery", () => {
  const l = createRetryLadder([10, 20]);
  assert.equal(l.schedule(false), null);
  assert.equal(l.schedule(true), 10, "the offline attempt spent a rung");
});

test("a rung survives the round it was armed during, and re-asks after it", () => {
  // A trigger landing mid-round: the round itself never asked for a rung, so this one
  // is still pending when its ack comes back. An answer stands it down…
  const l = createRetryLadder([10]);
  assert.equal(l.schedule(true), 10, "the mid-round request did not arm");
  l.answered();
  assert.equal(l.schedule(true), 10, "the answered round left the ladder armed");
});

test("a rejected ack leaves the armed rung standing", () => {
  // `rtc-closed` reaches the hook's callback with ok=false: the host was never reached,
  // so the caller re-arms instead of standing down — the rung armed mid-round is still
  // the one that fires, and a fresh failure does not skip ahead.
  const l = createRetryLadder([10, 20]);
  assert.equal(l.schedule(true), 10);
  assert.equal(l.schedule(true), null, "a second rung was armed while one was pending");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
