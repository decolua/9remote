// Characterization tests for the self-continued history fetch chain (historyChain.js).
// Run: node --import ./test/loader-alias.mjs web/test/historyChain.test.mjs
import assert from "node:assert/strict";
import { createHistoryChain } from "../features/terminal/lib/historyChain.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const make = ({ started = true, atTop = true } = {}) => {
  const calls = [];
  let top = atTop;
  const chain = createHistoryChain({
    fetchOlder: (auto) => { calls.push(auto); return started; },
    isAtTop: () => top,
    max: 3,
    delayMs: 5
  });
  return { chain, calls, setTop: (v) => { top = v; } };
};

test("a gesture that starts a fetch opens a budget of max continuations", async () => {
  const { chain, calls } = make();
  chain.gesture();
  for (let i = 0; i < 4; i++) { chain.settled(); await sleep(10); }
  // 1 gesture + 3 continuations, then the budget is spent — the 4th settled is ignored.
  assert.deepEqual(calls, [false, true, true, true]);
});

test("settled() at the top with a spent budget does not fetch again", async () => {
  const { chain, calls } = make();
  chain.gesture();
  for (let i = 0; i < 3; i++) { chain.settled(); await sleep(10); }
  assert.equal(calls.length, 4);
  chain.settled(); chain.settled(); await sleep(10);
  assert.equal(calls.length, 4);
});

test("a gesture that starts nothing leaves the budget untouched", async () => {
  const blocked = make({ started: false });
  blocked.chain.gesture(); // blocked (guard / in-flight / not at top) → no fetch, no refill
  assert.deepEqual(blocked.calls, [false]);
  blocked.chain.settled(); await sleep(10);
  assert.deepEqual(blocked.calls, [false]); // still no continuation armed
});

test("leaving the top resets the budget", async () => {
  const { chain, calls, setTop } = make();
  chain.gesture();
  chain.settled(); await sleep(10);
  setTop(false);
  chain.settled(); // not at top → budget cleared, nothing armed
  await sleep(10);
  assert.deepEqual(calls, [false, true]);
  setTop(true);
  chain.gesture(); // a fresh gesture at the top gets a full budget again
  assert.equal(calls.length, 3);
});

test("cancel() drops a pending continuation", async () => {
  const { chain, calls } = make();
  chain.gesture();
  chain.settled();
  chain.cancel();
  await sleep(10);
  assert.deepEqual(calls, [false]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
