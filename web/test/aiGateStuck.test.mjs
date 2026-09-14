// The client half of the stuck-gate fix: a gate must never be dropped by anything but
// the host's own ok, and a hydrate must not keep one the host no longer reports.
//
// Run: node web/test/aiGateStuck.test.mjs

import assert from "node:assert/strict";
import { useAiStore } from "../shared/stores/aiStore.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const seedGate = (requestId = "req-1") => {
  useAiStore.setState({
    bySession: {
      s1: {
        messages: [],
        activePermission: { requestId, tool: "AskUserQuestion", input: { questions: [] } },
        gateError: false
      }
    }
  });
};

test("setPermission clears a previous failure", () => {
  seedGate();
  useAiStore.getState().setGateError("s1", "req-1");
  assert.equal(useAiStore.getState().bySession.s1.gateError, true);
  useAiStore.getState().setPermission("s1", { requestId: "req-1", tool: "Bash", input: {} });
  assert.equal(useAiStore.getState().bySession.s1.gateError, false);
});

test("setGateError ignores a gate that already moved on", () => {
  seedGate("req-2");
  useAiStore.getState().setGateError("s1", "req-1");
  assert.equal(useAiStore.getState().bySession.s1.gateError, false);
});

test("hydrateSession drops a gate the host did not replay", () => {
  seedGate();
  useAiStore.getState().hydrateSession("s1", { messages: [] });
  assert.equal(useAiStore.getState().bySession.s1.activePermission, null);
});

test("a replayed gate is set back on top of the hydrate", () => {
  seedGate();
  useAiStore.getState().hydrateSession("s1", { messages: [] });
  useAiStore.getState().setPermission("s1", { requestId: "req-9", tool: "AskUserQuestion", input: {} });
  assert.equal(useAiStore.getState().bySession.s1.activePermission.requestId, "req-9");
});

test("a cleared gate cannot leave a failure behind it", () => {
  seedGate();
  useAiStore.getState().setGateError("s1", "req-1");
  useAiStore.getState().clearPermission("s1", "req-1");
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.activePermission, null);
  // Nothing renders the flag once the card is gone, but a later gate must not inherit it.
  useAiStore.getState().setPermission("s1", { requestId: "req-3", tool: "Bash", input: {} });
  assert.equal(useAiStore.getState().bySession.s1.gateError, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
