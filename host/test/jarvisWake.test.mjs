// jarvisWake — the trigger that reaches the standalone conductor when a worker
// finishes: debounce batching, the off switch, and every event counting once.
// The wake itself is injected (the real one is a Gemini turn, out of scope here
// — jarvisAgent.test.mjs owns that loop).
//
// Run: node agent/test/jarvisWake.test.mjs
import assert from "node:assert/strict";
import { createJarvisWake } from "../features/jarvis/jarvisWake.js";

let pass = 0, fail = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("Running jarvis wake tests...");

test("a finished worker wakes the conductor once, after the debounce", async () => {
  const woken = [];
  let refreshes = 0;
  const wake = createJarvisWake({
    wake: async (text) => { woken.push(text); return {}; },
    refreshBoard: () => { refreshes++; },
    debounceMs: 5
  });
  wake.onWorkerDone("s-1");
  wake.onWorkerDone("s-1"); // duplicate event — same worker, one mention
  assert.equal(refreshes, 2, "the board folds on every event, unbatched");
  await sleep(30);
  assert.equal(woken.length, 1);
  assert.match(woken[0], /s-1/);
});

test("workers finishing together share one wake", async () => {
  const woken = [];
  const wake = createJarvisWake({
    wake: async (text) => { woken.push(text); return {}; },
    refreshBoard: () => {},
    debounceMs: 10
  });
  wake.onWorkerDone("s-1");
  await sleep(2);
  wake.onWorkerDone("s-2");
  await sleep(40);
  assert.equal(woken.length, 1, "one batched prompt");
  assert.match(woken[0], /s-1/);
  assert.match(woken[0], /s-2/);
});

test("a wake that fails is swallowed — the board fold already carried the truth", async () => {
  let refreshes = 0;
  const wake = createJarvisWake({
    wake: async () => { throw new Error("gemini down"); },
    refreshBoard: () => { refreshes++; },
    debounceMs: 5
  });
  wake.onWorkerDone("s-1");
  await sleep(20);
  assert.equal(refreshes, 1, "the fold still ran");
});

test("the off switch stops both the fold and the wake", async () => {
  const woken = [];
  let refreshes = 0;
  const wake = createJarvisWake({
    wake: async (text) => { woken.push(text); return {}; },
    refreshBoard: () => { refreshes++; },
    debounceMs: 5
  });
  wake.setWakeEnabled(false);
  wake.onWorkerDone("s-9");
  await sleep(20);
  assert.equal(woken.length, 0);
  assert.equal(refreshes, 0);
});

for (const { name, fn } of cases) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
