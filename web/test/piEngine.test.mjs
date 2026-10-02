// PiEngine registry wiring: meta, tool categories, UI option, gates.
// Run: node --import ./test/loader-alias.mjs test/piEngine.test.mjs   (cwd: web/)
import assert from "node:assert/strict";
import { getEngine, listEngines, listAiUiOptions, getToolCategory } from "../features/ai/registry.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running pi engine tests...");

test("pi engine is registered with its meta", () => {
  const engine = getEngine("pi");
  assert.equal(engine.meta.id, "pi");
  assert.equal(engine.meta.label, "Pi");
});

test("pi appears in the engine and AI UI lists", () => {
  assert.ok(listEngines().some((m) => m.id === "pi"));
  assert.ok(listAiUiOptions().some((o) => o.aiEngine === "pi" && o.isAiUi));
});

test("pi's built-in tools map to the shared cards", () => {
  assert.equal(getToolCategory("pi", "bash"), "bash");
  assert.equal(getToolCategory("pi", "edit"), "diff");
  assert.equal(getToolCategory("pi", "write"), "diff");
  assert.equal(getToolCategory("pi", "read"), "file");
  assert.equal(getToolCategory("pi", "unknownThing"), "generic");
});

test("pi's dialog wire is answerable — questionGate on", () => {
  assert.equal(getEngine("pi").config.questionGate, true);
});

test("pi offers default + an enforced read-only tier", () => {
  const modes = getEngine("pi").config.permissionModes.map((m) => m.id);
  assert.deepEqual(modes, ["default", "readOnly"]);
});

test("pi has no static model fallback — runtime catalog only", () => {
  assert.deepEqual(getEngine("pi").config.models, []);
});

test("pi's '/' menu uses pi's own command names", () => {
  const names = getEngine("pi").config.slashCommands.map((c) => c.name);
  for (const real of ["/model", "/thinking", "/compact", "/resume", "/fork", "/clone", "/new", "/name", "/session"]) {
    assert.ok(names.includes(real), `${real} missing from the menu`);
  }
  for (const notPi of ["/effort", "/clear", "/rewind"]) {
    assert.ok(!names.includes(notPi), `${notPi} is not pi vocabulary`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
