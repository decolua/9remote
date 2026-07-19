// Tests for resetReconnectState — guards R2/R3 reconnect state bugs.
// Run: node web/test/reconnectState.test.mjs
import assert from "node:assert/strict";
import { resetReconnectState } from "../features/terminal/lib/reconnectState.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const mkRef = (v) => ({ current: v });

test("R2: clears historyFetchingRef (stuck true → false)", () => {
  const ref = mkRef(true);
  resetReconnectState({ historyFetching: ref });
  assert.equal(ref.current, false);
});

test("R2: clears historyHaveAtEmitRef (stuck snapshot → 0)", () => {
  const ref = mkRef(12345);
  resetReconnectState({ historyHaveAtEmit: ref });
  assert.equal(ref.current, 0);
});

test("R3: clears awaitingTuiOutputRef (stuck true → false)", () => {
  const ref = mkRef(true);
  resetReconnectState({ awaitingTuiOutput: ref });
  assert.equal(ref.current, false);
});

test("clears all three together", () => {
  const refs = {
    historyFetching: mkRef(true),
    historyHaveAtEmit: mkRef(99),
    awaitingTuiOutput: mkRef(true),
  };
  resetReconnectState(refs);
  assert.equal(refs.historyFetching.current, false);
  assert.equal(refs.historyHaveAtEmit.current, 0);
  assert.equal(refs.awaitingTuiOutput.current, false);
});

test("no-op on null/undefined refs", () => {
  resetReconnectState(null);
  resetReconnectState(undefined);
  resetReconnectState({});
  // no throw
  assert.ok(true);
});

test("ignores missing keys (partial refs object)", () => {
  const ref = mkRef(true);
  resetReconnectState({ historyFetching: ref }); // only one key
  assert.equal(ref.current, false);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
