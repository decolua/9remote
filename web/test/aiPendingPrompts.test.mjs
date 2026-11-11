// A reload between "sent" and "acked" used to lose the prompt: the composer had already
// cleared it and the error bar lives in memory. These pin the localStorage ledger.
// Run: node --import ./test/loader-alias.mjs test/aiPendingPrompts.test.mjs
import assert from "node:assert/strict";
import { addPending, readPending, removePending, removePendingByText, removePendingWithin, takeOrphans } from "../features/ai/lib/pendingPrompts.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), size: () => m.size };
};

test("an acked prompt leaves nothing behind", () => {
  const st = memStorage();
  addPending("s", { id: "p1", text: "hi", page: "A" }, st);
  removePending("s", "p1", st);
  assert.deepEqual(readPending("s", st), []);
  assert.equal(st.size(), 0, "empty list removes the key");
});

test("the echo clears the entry holding that text", () => {
  const st = memStorage();
  addPending("s", { id: "p1", text: "one", page: "A" }, st);
  addPending("s", { id: "p2", text: "two", page: "A" }, st);
  removePendingByText("s", "one", st);
  assert.deepEqual(readPending("s", st).map((p) => p.id), ["p2"]);
});

test("a reload offers back what the replayed log does not show", () => {
  const st = memStorage();
  addPending("s", { id: "p1", text: "delivered", page: "OLD", at: 0 }, st);
  addPending("s", { id: "p2", text: "lost", page: "OLD", at: 0 }, st);
  const orphans = takeOrphans("s", { deliveredTexts: ["delivered"], page: "NEW", minAgeMs: 8000, now: 10_000 }, st);
  assert.deepEqual(orphans.map((p) => p.text), ["lost"]);
  assert.deepEqual(readPending("s", st), [], "taken once — a second hydrate offers nothing");
});

test("this page's own in-flight prompt is never an orphan", () => {
  const st = memStorage();
  addPending("s", { id: "p1", text: "mine", page: "A", at: 0 }, st);
  assert.deepEqual(takeOrphans("s", { page: "A", minAgeMs: 0, now: 99_999 }, st), []);
  assert.equal(readPending("s", st).length, 1, "kept for its own ack");
});

test("another tab's young prompt is left alone — it may still ack", () => {
  const st = memStorage();
  addPending("s", { id: "p1", text: "theirs", page: "B", at: 9_000 }, st);
  assert.deepEqual(takeOrphans("s", { page: "A", minAgeMs: 8000, now: 10_000 }, st), []);
  assert.equal(readPending("s", st).length, 1);
});

test("dismissing a merged loss forgets every prompt folded into it", () => {
  const st = memStorage();
  addPending("s", { id: "p1", text: "first", page: "A" }, st);
  addPending("s", { id: "p2", text: "second", page: "A" }, st);
  addPending("s", { id: "p3", text: "other", page: "A" }, st);
  removePendingWithin("s", "first\n\nsecond", st);
  assert.deepEqual(readPending("s", st).map((p) => p.id), ["p3"]);
});

test("corrupt or missing storage reads as empty, never throws", () => {
  const st = memStorage();
  st.setItem("9remote_pendingPrompts_s", "{not json");
  assert.deepEqual(readPending("s", st), []);
  assert.deepEqual(readPending("s", null), []);
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }, removeItem() {} };
  assert.doesNotThrow(() => addPending("s", { id: "p", text: "t" }, throwing));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
