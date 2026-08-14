// Characterization tests for the explorer path helpers.
// joinPath/dirname feed every create, rename, delete and drag-move, so an
// off-by-one slash here corrupts real files on the host.
// Run: node --import ./test/loader-alias.mjs web/test/pathUtils.test.mjs
import assert from "node:assert/strict";
import { joinPath, dirname, relativeTo, basename } from "../features/fileExplorer/lib/pathUtils.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("joinPath never doubles the separator", () => {
  assert.equal(joinPath("/a/b", "c.js"), "/a/b/c.js");
  assert.equal(joinPath("/a/b/", "c.js"), "/a/b/c.js");
  assert.equal(joinPath("/", "c.js"), "/c.js");
});

test("joinPath with no dir returns the bare name", () => {
  assert.equal(joinPath("", "c.js"), "c.js");
  assert.equal(joinPath(null, "c.js"), "c.js");
});

test("dirname walks up one level", () => {
  assert.equal(dirname("/a/b/c.js"), "/a/b");
  assert.equal(dirname("/a/b"), "/a");
});

test("dirname of a root-level path stays at root (never empty)", () => {
  // An empty string here would make joinPath produce a relative path and the
  // agent would resolve it against its own cwd.
  assert.equal(dirname("/a"), "/");
  assert.equal(dirname("/"), "/");
  assert.equal(dirname("a.js"), "/", "no separator → treated as root");
});

test("joinPath(dirname(p), name) round-trips a rename", () => {
  const p = "/w/src/old.js";
  assert.equal(joinPath(dirname(p), "new.js"), "/w/src/new.js");
});

test("relativeTo strips the workspace prefix", () => {
  assert.equal(relativeTo("/w", "/w/src/a.js"), "src/a.js");
  assert.equal(relativeTo("/w", "/w"), "/w", "the root itself is not rewritten");
  assert.equal(relativeTo(null, "/w/a.js"), "/w/a.js");
  assert.equal(relativeTo("/w", null), null);
});

test("basename returns the last segment, tolerating trailing slashes", () => {
  assert.equal(basename("/a/b/c"), "c");
  assert.equal(basename("/a/b/c/"), "c");
  assert.equal(basename("/"), "/");
  assert.equal(basename(""), "");
  assert.equal(basename(null), "");
});

test("a folder can never be moved inside itself (guard the drag-drop uses)", () => {
  const src = "/w/src";
  const dest = joinPath("/w/src/nested", "src");
  assert.ok(dest.startsWith(src + "/"), "guard must catch this as a self-move");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
