// Characterization tests for the unified-diff parser extracted from GitPanel.
// The line numbers it emits are what the mobile diff view shows next to each
// row — an off-by-one makes every reported line wrong.
// Run: node --import ./test/loader-alias.mjs web/test/unifiedDiff.test.mjs
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "../features/fileExplorer/lib/unifiedDiff.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const DIFF = [
  "diff --git a/src/app.js b/src/app.js",
  "index 1234567..89abcde 100644",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -10,3 +10,4 @@ function main() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " return a;"
].join("\n");

test("emits a file row carrying just the path", () => {
  const rows = parseUnifiedDiff(DIFF);
  assert.deepEqual(rows[0], { type: "file", text: "src/app.js" });
});

test("index / --- / +++ header lines are dropped entirely", () => {
  const rows = parseUnifiedDiff(DIFF);
  assert.equal(rows.filter((r) => r.text?.startsWith("index ")).length, 0);
  assert.equal(rows.filter((r) => r.type === "file").length, 1);
});

test("hunk header seeds both line counters", () => {
  const rows = parseUnifiedDiff(DIFF);
  const hunk = rows.find((r) => r.type === "hunk");
  assert.match(hunk.text, /^@@ -10,3 \+10,4 @@/);
  // first context row after the hunk starts at the seeded numbers
  const ctx = rows.find((r) => r.type === "ctx");
  assert.equal(ctx.oldLn, 10);
  assert.equal(ctx.newLn, 10);
});

test("added lines advance only the new counter", () => {
  const rows = parseUnifiedDiff(DIFF);
  const adds = rows.filter((r) => r.type === "add");
  assert.deepEqual(adds.map((r) => r.text), ["const b = 3;", "const c = 4;"]);
  assert.deepEqual(adds.map((r) => r.newLn), [11, 12]);
  assert.equal(adds.every((r) => r.oldLn === undefined), true, "an added line has no old number");
});

test("deleted lines advance only the old counter", () => {
  const rows = parseUnifiedDiff(DIFF);
  const del = rows.find((r) => r.type === "del");
  assert.equal(del.text, "const b = 2;");
  assert.equal(del.oldLn, 11);
  assert.equal(del.newLn, undefined);
});

test("context lines advance both counters and keep the diverged numbering", () => {
  const rows = parseUnifiedDiff(DIFF);
  const ctxs = rows.filter((r) => r.type === "ctx");
  assert.deepEqual(ctxs.map((r) => r.text), ["const a = 1;", "return a;"]);
  // after 1 delete and 2 adds the two sides have drifted apart
  assert.deepEqual(ctxs.at(-1), { type: "ctx", text: "return a;", oldLn: 12, newLn: 13 });
});

test("hunk without a count (@@ -1 +1 @@) still parses", () => {
  const rows = parseUnifiedDiff("@@ -5 +7 @@\n+x");
  assert.equal(rows.find((r) => r.type === "add").newLn, 7);
});

test("a second hunk re-seeds the counters", () => {
  const rows = parseUnifiedDiff("@@ -1,1 +1,1 @@\n+a\n@@ -100,1 +200,1 @@\n+b");
  const adds = rows.filter((r) => r.type === "add");
  assert.deepEqual(adds.map((r) => r.newLn), [1, 200]);
});

test("new-file and deleted-file headers are skipped", () => {
  const rows = parseUnifiedDiff("diff --git a/x b/x\nnew file mode 100644\n@@ -0,0 +1 @@\n+hi");
  assert.deepEqual(rows.map((r) => r.type), ["file", "hunk", "add"]);
});

test("empty input yields a single empty context row (not a crash)", () => {
  const rows = parseUnifiedDiff("");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "ctx");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
