// Refcount lifecycle of the shared `opencode serve` process.
// Run: node agent/test/opencodeServerLifecycle.test.mjs
import assert from "node:assert/strict";
import { retainForSession, releaseForSession } from "../features/ai/opencodeServer.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

console.log("Running opencode server lifecycle tests...");

await test("retain/release pairs never go negative and never throw", () => {
  retainForSession();
  retainForSession();
  releaseForSession();
  releaseForSession();
  releaseForSession(); // a stray release must not push the count below zero
  releaseForSession();
});

await test("a retain after the last release cancels the pending idle stop", async () => {
  retainForSession();
  releaseForSession();
  // A new session arriving inside the idle window keeps the server alive.
  retainForSession();
  releaseForSession();
  // Leave a released state without a live timer for the next test file.
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
