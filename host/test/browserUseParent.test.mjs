// TDD for --parent section scoping: the calling LLM has read the tree, so it
// names the section and Jev's table shrinks to it — no cross-section confusion.
// Offline + pure. Run: node host/test/browserUseParent.test.mjs
import assert from "node:assert/strict";
import { scopeByParent, buildActionSpace, buildQuestions } from "../features/browserUse/agentLoop.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// The probe dataset: same-label Save in two sections, ctx identical.
const actions = () => [
  { id: "e1", node: 1, role: "button", label: "Save", kind: "click", ctx: "Logs", value: "", path: ["Billing", "Logs"] },
  { id: "e2", node: 2, role: "button", label: "Save", kind: "click", ctx: "Logs", value: "", path: ["Shipping", "Logs"] },
  { id: "scroll_down", node: 0, role: null, label: "Scroll down", kind: "scroll", ctx: null, value: "", delta: 560 },
  { id: "wait", node: 0, role: null, label: "Wait", kind: "wait", ctx: null, value: "" }
];

console.log("scopeByParent...");

test("keeps only actions inside the matching section, controls survive", () => {
  const out = scopeByParent(actions(), "Shipping");
  assert.deepEqual(out.map((a) => a.id), ["e2", "scroll_down", "wait"]);
});

test("match is case-insensitive substring on path segments", () => {
  const out = scopeByParent(actions(), "ship");
  assert.deepEqual(out.map((a) => a.id), ["e2", "scroll_down", "wait"]);
});

test("falls back to ctx when path is missing", () => {
  const noPath = actions().map((a) => ({ ...a, path: undefined }));
  const out = scopeByParent(noPath, "Logs");
  // both sections' innermost ctx is "Logs" — a parent that broad keeps both
  assert.deepEqual(out.map((a) => a.id), ["e1", "e2", "scroll_down", "wait"]);
});

test("no parent returns the array untouched", () => {
  const src = actions();
  assert.equal(scopeByParent(src, null), src);
  assert.equal(scopeByParent(src, ""), src);
});

test("parent matching nothing still keeps the controls", () => {
  const out = scopeByParent(actions(), "Nonexistent");
  assert.deepEqual(out.map((a) => a.id), ["scroll_down", "wait"]);
});

console.log("\nend-to-end contract (pure)...");

test("--parent Shipping leaves Jev a single Save — nothing left to confuse", () => {
  const scoped = scopeByParent(actions(), "Shipping");
  const space = buildActionSpace(scoped);
  const body = buildQuestions(
    { url: "https://x", title: "t", text: "", actions: scoped }, "press Save", [], space);
  const criteria = body.questions.click_target.criteria;
  assert.deepEqual(Object.keys(criteria), ["e2"]);
  // the scoped tree shrinks with the table — no redundant full tree either
  assert.ok(body.state.page.tree.includes("e2"));
  assert.ok(!body.state.page.tree.includes("e1"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
