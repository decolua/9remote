// Snippet aliases in the AI composer: typing the alias has to reach the agent as the
// prompt it stands for, not as the alias itself.
//
// The composer needs a DOM, so this pins the store rule it now calls on send.
//
// Run: node --import ./test/loader-alias.mjs web/test/composerSnippet.test.mjs
import assert from "node:assert/strict";
import { useAiHistoryStore } from "../shared/stores/historyStore.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running composer snippet tests...");

test("an alias on its own expands to its prompt", () => {
  useAiHistoryStore.setState({ history: [], pinned: [{ cmd: "npm run dev", alias: "nrd" }] });
  assert.equal(useAiHistoryStore.getState().resolveAlias("nrd"), "npm run dev");
});

test("surrounding whitespace does not stop the expansion", () => {
  assert.equal(useAiHistoryStore.getState().resolveAlias("  nrd  "), "npm run dev");
});

test("an alias inside a sentence is left alone — it is not a command there", () => {
  assert.equal(useAiHistoryStore.getState().resolveAlias("run nrd now"), "run nrd now");
});

test("a plain prompt passes through untouched", () => {
  assert.equal(useAiHistoryStore.getState().resolveAlias("explain this repo"), "explain this repo");
});

test("a snippet with no alias never swallows the text", () => {
  useAiHistoryStore.setState({ history: [], pinned: [{ cmd: "npm run dev", alias: "" }] });
  assert.equal(useAiHistoryStore.getState().resolveAlias("npm run dev"), "npm run dev");
});

console.log(`\n${fail === 0 ? "✅ all passed" : "❌ FAILED"}, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
