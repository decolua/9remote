// A prompt must survive the send even when the send does not: Resend and the
// auto-resend after a reconnect bypass the composer, and used to leave no trace
// in prompt history at all.
// Run: node --import ./test/loader-alias.mjs test/promptHistory.test.mjs
import assert from "node:assert/strict";
import { rememberPrompt } from "../features/ai/lib/promptHistory.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// The store is injected so the test never touches the real history.
const fakeStore = () => {
  const added = [];
  return { added, getState: () => ({ addCommand: (text) => added.push(text) }) };
};

test("a prompt that bypassed the composer is remembered", () => {
  const store = fakeStore();
  rememberPrompt("resend me", store);
  assert.deepEqual(store.added, ["resend me"]);
});

test("surrounding whitespace is trimmed like the composer does", () => {
  const store = fakeStore();
  rememberPrompt("  hi  \n", store);
  assert.deepEqual(store.added, ["hi"]);
});

test("an empty prompt records nothing", () => {
  const store = fakeStore();
  rememberPrompt("", store);
  rememberPrompt("   ", store);
  rememberPrompt(null, store);
  assert.deepEqual(store.added, []);
});

test("a shell command stays out of prompt history", () => {
  const store = fakeStore();
  rememberPrompt("! ls -la", store);
  assert.deepEqual(store.added, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
