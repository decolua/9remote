// Explorer row indentation. The compact tree docks next to a terminal where every pixel
// of width is contested, so its indent must actually be smaller — a regression here is
// invisible in code review but eats the tree's usable width at depth.
// Run: node --import ./test/loader-alias.mjs test/explorerRowMetrics.test.mjs
import assert from "node:assert/strict";
import { EXPLORER_ROW } from "../features/fileExplorer/constants/fileExplorer.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Mirrors ExplorerRow.indentFor without pulling in JSX.
const indentFor = (depth, compact = false) => {
  const m = compact ? EXPLORER_ROW.compact : EXPLORER_ROW.normal;
  return m.indentBase + depth * m.indentStep;
};

test("normal metrics are unchanged from the standalone explorer", () => {
  assert.equal(indentFor(0), 12);
  assert.equal(indentFor(1), 24);
  assert.equal(indentFor(3), 48);
});

test("compact indents less at every depth", () => {
  for (const depth of [0, 1, 2, 5, 10]) {
    assert.ok(indentFor(depth, true) <= indentFor(depth), `depth ${depth}`);
  }
  assert.ok(indentFor(5, true) < indentFor(5), "and strictly less once nested");
});

test("compact saves real width at the depths trees actually reach", () => {
  const saved = indentFor(6) - indentFor(6, true);
  assert.ok(saved >= 28, `expected to reclaim ~30px at depth 6, got ${saved}`);
});

test("compact icons and text are smaller, never larger", () => {
  assert.ok(EXPLORER_ROW.compact.icon < EXPLORER_ROW.normal.icon);
  assert.ok(EXPLORER_ROW.compact.chevron < EXPLORER_ROW.normal.chevron);
  assert.notEqual(EXPLORER_ROW.compact.text, EXPLORER_ROW.normal.text);
});

test("both variants define every metric the row reads", () => {
  const keys = ["indentBase", "indentStep", "icon", "chevron", "text", "padY"];
  for (const variant of ["normal", "compact"]) {
    for (const k of keys) {
      assert.ok(EXPLORER_ROW[variant][k] !== undefined, `${variant}.${k}`);
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
