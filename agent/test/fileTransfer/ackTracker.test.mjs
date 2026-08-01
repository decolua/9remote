// Unit tests for cumulative-ACK tracker (TDD — module not yet implemented).
// Agent receives unordered chunks; AckTracker reports the contiguous high-watermark
// so the client can cumulatively ACK once per advance (few messages, high throughput).
// Run: node agent/test/fileTransfer/ackTracker.test.mjs
import assert from "node:assert/strict";
import { AckTracker } from "../../features/fileExplorer/transfer/ackTracker.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

await test("in-order marks advance watermark monotonically", () => {
  const t = new AckTracker(1000, 250); // 4 chunks of 250
  assert.equal(t.mark(0, 250), 250);
  assert.equal(t.mark(250, 250), 500);
  assert.equal(t.mark(500, 250), 750);
  assert.equal(t.mark(750, 250), 1000);
  assert.equal(t.highWatermark(), 1000);
  assert.equal(t.isComplete(), true);
});

await test("out-of-order: no advance until gap fills", () => {
  const t = new AckTracker(1000, 250);
  assert.equal(t.mark(250, 250), null);   // gap at 0 → no advance
  assert.equal(t.highWatermark(), 0);
  assert.equal(t.mark(750, 250), null);   // still gap → no advance
  assert.equal(t.mark(0, 250), 500);      // fills gap 0, contiguous 0..500 → advance
  assert.equal(t.mark(500, 250), 1000);   // fills last gap → complete
  assert.equal(t.isComplete(), true);
});

await test("duplicate chunk is idempotent", () => {
  const t = new AckTracker(500, 250);
  t.mark(0, 250);
  assert.equal(t.mark(0, 250), null);     // already covered, no new advance
  assert.equal(t.highWatermark(), 250);
});

await test("final partial-length chunk completes", () => {
  const t = new AckTracker(100, 30); // offsets 0,30,60,90 (len 10 last)
  t.mark(0, 30); t.mark(30, 30); t.mark(60, 30);
  assert.equal(t.isComplete(), false);
  assert.equal(t.mark(90, 10), 100);
  assert.equal(t.isComplete(), true);
});

await test("zero-size file: immediately complete, no marks", () => {
  const t = new AckTracker(0, 1024);
  assert.equal(t.highWatermark(), 0);
  assert.equal(t.isComplete(), true);
});

await test("never over-ack beyond totalSize", () => {
  const t = new AckTracker(500, 250);
  t.mark(0, 250);
  t.mark(250, 250);
  assert.ok(t.highWatermark() <= 500);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
