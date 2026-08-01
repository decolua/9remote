// Unit tests for conflict resolver (TDD — module not yet implemented).
// OS-like copy conflict: per-file Skip/Replace + global Skip-all/Replace-all.
// Pure logic, no React — mirror into web/features/fileExplorer/lib/conflict.js.
// Run: node agent/test/fileTransfer/conflict.test.mjs
import assert from "node:assert/strict";
import { ConflictResolver, CONFLICT_CHOICE } from "../../../web/features/fileExplorer/lib/conflict.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

await test("file does not exist → write immediately", () => {
  const r = new ConflictResolver();
  assert.equal(r.resolve(false), "write");
});

await test("file exists, no global set → ask", () => {
  const r = new ConflictResolver();
  assert.equal(r.resolve(true), "ask");
});

await test("user picks Replace on one file → next conflict still asks (non-global)", () => {
  const r = new ConflictResolver();
  r.record(CONFLICT_CHOICE.REPLACE);
  assert.equal(r.resolve(true), "ask");
});

await test("user picks Replace-all → all subsequent conflicts = replace", () => {
  const r = new ConflictResolver();
  r.record(CONFLICT_CHOICE.REPLACE_ALL);
  assert.equal(r.resolve(true), "replace");
  assert.equal(r.resolve(true), "replace");
});

await test("user picks Skip-all → all subsequent conflicts = skip", () => {
  const r = new ConflictResolver();
  r.record(CONFLICT_CHOICE.SKIP_ALL);
  assert.equal(r.resolve(true), "skip");
  assert.equal(r.resolve(true), "skip");
});

await test("non-existent file always writes regardless of skip-all", () => {
  const r = new ConflictResolver();
  r.record(CONFLICT_CHOICE.SKIP_ALL);
  assert.equal(r.resolve(false), "write");
});

await test("replace-all wins over skip-all if set later", () => {
  const r = new ConflictResolver();
  r.record(CONFLICT_CHOICE.SKIP_ALL);
  r.record(CONFLICT_CHOICE.REPLACE_ALL);
  assert.equal(r.resolve(true), "replace");
});

await test("choices enum has 4 values", () => {
  assert.deepEqual(Object.values(CONFLICT_CHOICE).sort(), ["replace", "replaceAll", "skip", "skipAll"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
