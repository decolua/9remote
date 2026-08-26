// The recovery lane admits ONE occupant. A blind reset+rejoin is one of them —
// it was not, which is why a second trigger arriving during a rejoin wiped the
// scrollback that rejoin had just painted (spinner flashing twice, the whole
// tail pulled over the wire again).
// Run: node --import ./test/loader-alias.mjs web/test/recoverSingleFlight.test.mjs
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

import { recoveryBusy } from "../features/terminal/lib/reconnectState.js";

// Call the shipped rule, never a restatement of it — a copy here would keep
// passing after the real one drifted.
const mkRef = (v) => ({ current: v });
const laneBusy = ({ joinClaimed, joining, gapBusy }) =>
  recoveryBusy({ joinClaimed: mkRef(joinClaimed), joining: mkRef(joining), gapBusy });

test("a claimed join holds the lane — a second trigger stands down", () => {
  // hardRejoin resets the terminal, then emits. joiningRef only rises inside the
  // join ack, so this window is the one that used to be unguarded.
  const state = { joinClaimed: true, joining: false, gapBusy: false };
  assert.equal(laneBusy(state), true, "the reset must not be repeated on top of itself");
});

test("the join claim is what closes the window — drop it and the lane reads free", () => {
  // Same state minus the rejoin term: this is exactly the rule that shipped
  // before, and exactly why the second reset got through.
  assert.equal(recoveryBusy({ joining: mkRef(false), gapBusy: false }), false);
});

test("the lane frees once the join acks", () => {
  const state = { joinClaimed: false, joining: false, gapBusy: false };
  assert.equal(laneBusy(state), false);
});

test("peek and gapFetch still hold the lane on their own", () => {
  assert.equal(laneBusy({ joinClaimed: false, joining: true, gapBusy: false }), true);
  assert.equal(laneBusy({ joinClaimed: false, joining: false, gapBusy: true }), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
