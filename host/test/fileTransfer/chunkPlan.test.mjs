// Unit tests for chunk planning (TDD — module not yet implemented).
// planChunks(size, chunkSize) → [{ offset, length }] covering [0, size).
// Run: node agent/test/fileTransfer/chunkPlan.test.mjs
import assert from "node:assert/strict";
import { planChunks } from "../../features/fileExplorer/transfer/chunkPlan.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

await test("exact multiple — no remainder chunk", () => {
  const chunks = planChunks(100, 25);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks, [
    { offset: 0, length: 25 },
    { offset: 25, length: 25 },
    { offset: 50, length: 25 },
    { offset: 75, length: 25 },
  ]);
});

await test("remainder produces shorter final chunk", () => {
  const chunks = planChunks(100, 30);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks[3], { offset: 90, length: 10 });
});

await test("size 0 → empty plan (no chunks)", () => {
  assert.deepEqual(planChunks(0, 1024), []);
});

await test("single chunk when size < chunkSize", () => {
  const chunks = planChunks(10, 1024);
  assert.deepEqual(chunks, [{ offset: 0, length: 10 }]);
});

await test("offsets are contiguous and cover exactly [0, size)", () => {
  const size = 1024 * 1024 * 10;
  const chunkSize = 256 * 1024;
  const chunks = planChunks(size, chunkSize);
  let prevEnd = 0;
  for (const c of chunks) {
    assert.equal(c.offset, prevEnd, "offset must be contiguous from previous end");
    assert.ok(c.length > 0 && c.length <= chunkSize, "length within (0, chunkSize]");
    prevEnd = c.offset + c.length;
  }
  assert.equal(prevEnd, size);
});

await test("real-world: 50MB file / 256KB chunks = 200 chunks", () => {
  const chunks = planChunks(50 * 1024 * 1024, 256 * 1024);
  assert.equal(chunks.length, 200);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
