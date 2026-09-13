import assert from "node:assert/strict";
import { useAiStore } from "../shared/stores/aiStore.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// persist's partialize keeps prefs only, so a session rehydrated from localStorage has
// no messages/stats/tasks. Actions must still work off the defaults.
const seedPartial = () => {
  useAiStore.setState({ bySession: { s1: { permissionMode: "acceptEdits", metadata: { model: "opus" } } } });
};

test("appendThinking on a session slice with no messages", () => {
  seedPartial();
  useAiStore.getState().appendThinking("s1", "hmm");
  assert.equal(useAiStore.getState().bySession.s1.messages.length, 1);
  assert.equal(useAiStore.getState().bySession.s1.messages[0].thinking, "hmm");
});

test("appendDelta keeps the prefs it was rehydrated with", () => {
  seedPartial();
  useAiStore.getState().appendDelta("s1", "hi");
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.messages[0].content, "hi");
  assert.equal(sess.permissionMode, "acceptEdits");
  assert.equal(sess.metadata.model, "opus");
});

test("addUserMessage reads stats that the slice never carried", () => {
  seedPartial();
  useAiStore.getState().addUserMessage("s1", "do it");
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.messages.length, 2);
  assert.deepEqual(sess.turnBaseline, { inputTokens: 0, outputTokens: 0 });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
