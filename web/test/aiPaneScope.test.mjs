// Pane-scoped DOM anchors. Cards are addressed from outside themselves — the running-work
// strip scrolls to one by id — and tool ids are the host's, not this client's, so nothing
// keeps two chats' ids apart. Panes also stay mounted side by side. A bare `shell-<id>`
// therefore could name two elements, and `getElementById` returned whichever rendered
// first, so tapping a strip row scrolled a sibling pane.
//
// Run: node --import ./test/loader-alias.mjs web/test/aiPaneScope.test.mjs
import assert from "node:assert/strict";
import { anchorId, AiPaneScope, useAiPaneScope } from "../features/ai/components/PaneScope.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running pane-scope tests...");

test("the same tool id in two panes yields two distinct anchors", () => {
  const a = anchorId("session-1", "shell", "run_command-0");
  const b = anchorId("session-2", "shell", "run_command-0");
  assert.notEqual(a, b);
  assert.equal(a, "ai-session-1-shell-run_command-0");
  assert.equal(b, "ai-session-2-shell-run_command-0");
});

test("a card with no id gets no anchor, not one every card shares", () => {
  assert.equal(anchorId("session-1", "agent", ""), undefined);
  assert.equal(anchorId("session-1", "agent", null), undefined);
  assert.equal(anchorId("session-1", "agent", undefined), undefined);
});

test("agent and shell anchors stay apart within one pane", () => {
  assert.notEqual(anchorId("s", "agent", "x"), anchorId("s", "shell", "x"));
});

test("a card outside any pane keeps a usable anchor, and is the default", () => {
  // The dev preview page mounts cards with no pane above them; a missing provider must
  // still render, and must not claim to be a focused pane nobody can focus.
  assert.equal(AiPaneScope._currentValue.sessionId, "");
  assert.equal(AiPaneScope._currentValue.isFocused, true);
  assert.equal(AiPaneScope._currentValue.activate, null);
  assert.equal(typeof useAiPaneScope, "function");
  assert.equal(anchorId("", "shell", "b1"), "ai--shell-b1");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
