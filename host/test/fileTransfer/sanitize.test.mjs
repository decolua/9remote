// Unit tests for upload path sanitization (TDD — module not yet implemented).
// sanitizeRelativePath MUST reject traversal/absolute/backslash escapes so an
// attacker-controlled relativePath can't write outside targetDir.
// Run: node agent/test/fileTransfer/sanitize.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { sanitizeRelativePath, resolveSafePath } from "../../features/fileExplorer/transfer/sanitize.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const TARGET = path.posix.join("/home/user/project");

await test("simple filename accepted", () => {
  assert.equal(sanitizeRelativePath("notes.txt"), "notes.txt");
});

await test("nested subfolders accepted", () => {
  assert.equal(sanitizeRelativePath("src/a/b/c.js"), "src/a/b/c.js");
});

await test("reject parent traversal ../", () => {
  assert.throws(() => sanitizeRelativePath("../escape.txt"));
});

await test("reject deep traversal ../../etc/passwd", () => {
  assert.throws(() => sanitizeRelativePath("../../etc/passwd"));
});

await test("reject real escape; allow in-dir cancellation", () => {
  assert.throws(() => sanitizeRelativePath("a/b/../../../escape"));
  // "ok/../file" cancels inside target dir → stays inside, allowed
  assert.equal(sanitizeRelativePath("ok/../file.txt"), "file.txt");
});

await test("reject absolute path", () => {
  assert.throws(() => sanitizeRelativePath("/etc/shadow"));
});

await test("reject Windows absolute + drive", () => {
  assert.throws(() => sanitizeRelativePath("C:\\Windows\\system32"));
  assert.throws(() => sanitizeRelativePath("\\\\server\\share"));
});

await test("reject backslash separator (treat as traversal risk)", () => {
  assert.throws(() => sanitizeRelativePath("..\\escape"));
});

await test("reject empty / dot segments", () => {
  assert.throws(() => sanitizeRelativePath(""));
  assert.throws(() => sanitizeRelativePath("."));
  assert.throws(() => sanitizeRelativePath(".."));
});

await test("resolveSafePath lands inside targetDir", () => {
  const p = resolveSafePath(TARGET, "src/index.js");
  assert.equal(p, path.posix.join(TARGET, "src/index.js"));
});

await test("resolveSafePath result never escapes targetDir", () => {
  assert.throws(() => resolveSafePath(TARGET, "../outside"));
  const inside = resolveSafePath(TARGET, "deep/nested/file.txt");
  assert.ok(inside.startsWith(TARGET + "/"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
