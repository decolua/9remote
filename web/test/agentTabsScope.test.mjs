// Agent tabs (🤖 group of the terminal strip) belong to the workspace of the
// terminal session that opened them. A tab with no known owner (agent run from a
// shell outside the app) stays visible everywhere — hiding it would bring back
// "I can't see what the agent opened".
// Run: node --import ./test/loader-alias.mjs test/agentTabsScope.test.mjs
import assert from "node:assert/strict";
import { agentTabsForWorkspace } from "../features/browser/lib/agentTabsScope.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const tab = (id, extra = {}) => ({ id, profile: "default", title: id, windowId: 1, ...extra });

test("a tab owned by another workspace is hidden", () => {
  const out = agentTabsForWorkspace([tab("a", { workspaceId: "ws1" })], { wsKey: "ws2", profile: "default", ownTabs: [] });
  assert.deepEqual(out.map((t) => t.id), []);
});

test("a tab owned by this workspace is shown", () => {
  const out = agentTabsForWorkspace([tab("a", { workspaceId: "ws1" })], { wsKey: "ws1", profile: "default", ownTabs: [] });
  assert.deepEqual(out.map((t) => t.id), ["a"]);
});

test("ownerless tab stays visible in every workspace", () => {
  const list = [tab("a", { workspaceId: null }), tab("b")];
  for (const ws of ["ws1", "ws2", "default"]) {
    const out = agentTabsForWorkspace(list, { wsKey: ws, profile: "default", ownTabs: [] });
    assert.deepEqual(out.map((t) => t.id), ["a", "b"], ws);
  }
});

test("a tab already in this workspace's own strip is not duplicated", () => {
  const out = agentTabsForWorkspace([tab("a", { workspaceId: "ws1" })], { wsKey: "ws1", profile: "default", ownTabs: [{ id: "a" }] });
  assert.deepEqual(out, []);
});

test("same id under a DIFFERENT profile still shows (profiles are separate Chromes)", () => {
  const out = agentTabsForWorkspace([tab("a", { profile: "work", workspaceId: "ws1" })], { wsKey: "ws1", profile: "default", ownTabs: [{ id: "a" }] });
  assert.deepEqual(out.map((t) => t.id), ["a"]);
});

test("ungrouped sessions use the 'default' workspace key", () => {
  // Host sends workspaceId null for an ungrouped session; the strip keys it "default".
  const out = agentTabsForWorkspace([tab("a", { workspaceId: "default" })], { wsKey: "default", profile: "default", ownTabs: [] });
  assert.deepEqual(out.map((t) => t.id), ["a"]);
});

test("non-array input is empty, never throws", () => {
  assert.deepEqual(agentTabsForWorkspace(undefined, { wsKey: "ws1", profile: "default", ownTabs: [] }), []);
  assert.deepEqual(agentTabsForWorkspace(null, { wsKey: "ws1", profile: "default", ownTabs: [] }), []);
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : `\nAll ${pass} passed`);
process.exitCode = fail ? 1 : 0;
