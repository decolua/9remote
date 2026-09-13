// The watchdog that kills a silent turn reports itself as `stall`, not `error`: it
// fires on a timeout guess, so a slow build must release the turn WITHOUT painting an
// error bubble over the chat. `error` stays reserved for what the CLI actually
// reported, which still renders. Both are pinned here because the difference is one
// word in a switch and reads identically in the UI until the day it matters.
// Run: node --import ./test/loader-alias.mjs web/test/aiStallEvent.test.mjs
import assert from "node:assert/strict";
import { reduceSessionEvents } from "../features/ai/hooks/useAiSession.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running stall-event tests...");

const prompt = { event: "user_message", data: { text: "run the build" } };
const reply = { event: "delta", data: { text: "working" } };

test("a stall releases the turn", () => {
  const r = reduceSessionEvents([prompt, reply, { event: "stall", data: { message: "silent 120s" } }]);
  assert.equal(r.isTurnRunning, false);
});

test("a stall draws no bubble", () => {
  const r = reduceSessionEvents([prompt, reply, { event: "stall", data: { message: "silent 120s" } }]);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages.some((m) => /Error/.test(m.content)), false);
});

test("a stall stops the live spinner", () => {
  const r = reduceSessionEvents([prompt, reply, { event: "stall", data: {} }]);
  assert.equal(r.messages.some((m) => m.isLive), false);
});

test("an error still renders its text", () => {
  const r = reduceSessionEvents([prompt, { event: "error", data: { message: "spawn claude ENOENT" } }]);
  assert.equal(r.isTurnRunning, false);
  assert.match(r.messages.at(-1).content, /spawn claude ENOENT/);
});

test("a stall is its own event, not a reused stopped", () => {
  // Sharing `stopped` would make the replay log unable to tell a watchdog kill from
  // the user pressing Stop.
  const r = reduceSessionEvents([prompt, reply, { event: "stopped", data: {} }]);
  assert.equal(r.messages.length, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
