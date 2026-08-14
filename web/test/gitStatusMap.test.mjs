// Characterization tests for the git status map shared by both explorers.
// The parent-propagation rule is what makes a collapsed folder show it has
// changes inside; the reference-stability rule is what stops the whole tree
// re-rendering on every poll.
// Run: node --import ./test/loader-alias.mjs web/test/gitStatusMap.test.mjs
import assert from "node:assert/strict";
import { buildGitStatusMap, sameStatusMap } from "../features/fileExplorer/lib/gitStatusMap.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("failed / empty result yields an empty map", () => {
  assert.deepEqual(buildGitStatusMap({ success: false }), {});
  assert.deepEqual(buildGitStatusMap(null), {});
  assert.deepEqual(buildGitStatusMap({ success: true }), {});
  assert.deepEqual(buildGitStatusMap({ success: true, files: [] }), {});
});

test("marks the file and every ancestor folder", () => {
  const m = buildGitStatusMap({ success: true, files: [{ path: "src/app/page.js", status: "M" }] });
  assert.equal(m["src/app/page.js"], "M");
  assert.equal(m["src/app"], "folder-changed");
  assert.equal(m["src"], "folder-changed");
  assert.equal(Object.keys(m).length, 3);
});

test("a real file status is never overwritten by folder-changed", () => {
  // "src" is itself changed AND contains a changed file — the concrete status wins.
  const m = buildGitStatusMap({
    success: true,
    files: [{ path: "src", status: "A" }, { path: "src/a/b.js", status: "M" }]
  });
  assert.equal(m["src"], "A", "explicit status must survive ancestor propagation");
  assert.equal(m["src/a"], "folder-changed");
});

test("top-level file has no ancestors to mark", () => {
  const m = buildGitStatusMap({ success: true, files: [{ path: "README.md", status: "??" }] });
  assert.deepEqual(m, { "README.md": "??" });
});

test("accepts the alternate {file, code} payload shape", () => {
  const m = buildGitStatusMap({ success: true, files: [{ file: "a/b.txt", code: "D" }] });
  assert.equal(m["a/b.txt"], "D");
  assert.equal(m["a"], "folder-changed");
});

test("reads from result.status when result.files is absent", () => {
  const m = buildGitStatusMap({ success: true, status: [{ path: "x/y.js", status: "M" }] });
  assert.equal(m["x/y.js"], "M");
});

test("entries missing a path or status are skipped, not crashed on", () => {
  const m = buildGitStatusMap({
    success: true,
    files: [null, {}, { path: "a.js" }, { status: "M" }, { path: "ok.js", status: "M" }]
  });
  assert.deepEqual(m, { "ok.js": "M" });
});

test("deep nesting marks the whole chain exactly once", () => {
  const m = buildGitStatusMap({ success: true, files: [{ path: "a/b/c/d/e.js", status: "M" }] });
  assert.deepEqual(Object.keys(m).sort(), ["a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e.js"].sort());
});

test("sameStatusMap detects equality, additions, removals and value changes", () => {
  assert.equal(sameStatusMap({ a: "M" }, { a: "M" }), true);
  assert.equal(sameStatusMap({ a: "M" }, { a: "D" }), false);
  assert.equal(sameStatusMap({ a: "M" }, { a: "M", b: "M" }), false);
  assert.equal(sameStatusMap({ a: "M", b: "M" }, { a: "M" }), false);
  assert.equal(sameStatusMap({}, {}), true);
  assert.equal(sameStatusMap(null, {}), true, "null is treated as empty, not a crash");
});

test("sameStatusMap is what keeps the tree from re-rendering on an unchanged poll", () => {
  const r = { success: true, files: [{ path: "src/a.js", status: "M" }] };
  assert.equal(sameStatusMap(buildGitStatusMap(r), buildGitStatusMap(r)), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
