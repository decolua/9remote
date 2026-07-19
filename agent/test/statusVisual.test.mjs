// Tests for the statusVisual helper (agent UI mirror of web/shared/utils/statusVisual.js).
// Verifies all 4 states resolve to distinct dot colors + css classes, pulse flags, and
// fallback for unknown state. Run: node agent/test/statusVisual.test.mjs
import assert from "node:assert/strict";
import { STATUS_STYLE, statusVisual, dotClassName } from "../ui/src/lib/statusVisual.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("all 4 states defined", () => {
  assert.deepEqual(Object.keys(STATUS_STYLE).sort(), ["blocked", "done", "idle", "working"]);
});

test("each state has dot + cls + label", () => {
  for (const [state, v] of Object.entries(STATUS_STYLE)) {
    assert.ok(v.dot, `${state} has dot color`);
    assert.ok(v.cls, `${state} has css class`);
    assert.ok(v.label, `${state} has i18n label`);
  }
});

test("dot colors are distinct per state", () => {
  const colors = Object.values(STATUS_STYLE).map((v) => v.dot);
  assert.equal(new Set(colors).size, 4, "all 4 colors unique");
});

test("working + blocked pulse; idle + done do not", () => {
  assert.equal(STATUS_STYLE.working.pulse, "soft");
  assert.equal(STATUS_STYLE.blocked.pulse, "strong");
  assert.equal(STATUS_STYLE.idle.pulse, undefined);
  assert.equal(STATUS_STYLE.done.pulse, undefined);
});

test("statusVisual returns entry by state", () => {
  assert.equal(statusVisual("working"), STATUS_STYLE.working);
  assert.equal(statusVisual("blocked"), STATUS_STYLE.blocked);
});

test("statusVisual falls back to idle for unknown state", () => {
  assert.equal(statusVisual("unknown"), STATUS_STYLE.idle);
  assert.equal(statusVisual(undefined), STATUS_STYLE.idle);
  assert.equal(statusVisual(""), STATUS_STYLE.idle);
});

test("dotClassName builds term-dot + class + pulse", () => {
  assert.equal(dotClassName("working"), "term-dot st-working pulse-soft");
  assert.equal(dotClassName("blocked"), "term-dot st-blocked pulse-strong");
  assert.equal(dotClassName("idle"), "term-dot st-idle");
  assert.equal(dotClassName("done"), "term-dot st-done");
});

test("labels use common.* namespace (resolve via i18n resolvePath)", () => {
  for (const v of Object.values(STATUS_STYLE)) {
    assert.ok(v.label.startsWith("common."), `label ${v.label} is namespaced`);
  }
});

console.log(`\n${fail ? `❌ ${fail} failed` : "✅ all passed"}, ${pass} passed`);
if (fail) process.exit(1);
