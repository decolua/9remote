// The unsaved-edit guard, exercised as plain logic. With auto-save removed this is the
// only thing between a stray tap and lost work, so the rule that matters is: a leaving
// action never runs while edits are unsaved, and never runs after a failed save.
// Run: node --import ./test/loader-alias.mjs test/unsavedGuard.test.mjs
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};
const asyncTest = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// A minimal stand-in for the hook's reducer half — same branches, no React.
function makeGuard({ dirty, onSave }) {
  let pending = null;
  return {
    guard(action) {
      if (!dirty) return action();
      pending = action;
    },
    get asking() { return !!pending; },
    async saveThenLeave() {
      const ok = await onSave();
      if (!ok) return;
      const action = pending;
      pending = null;
      action?.();
    },
    discardAndLeave() {
      const action = pending;
      pending = null;
      action?.();
    },
    cancel() { pending = null; }
  };
}

test("a clean document leaves immediately, with no dialog", () => {
  let left = false;
  const g = makeGuard({ dirty: false, onSave: async () => true });
  g.guard(() => { left = true; });
  assert.equal(left, true);
  assert.equal(g.asking, false);
});

test("a dirty document asks first and does not leave", () => {
  let left = false;
  const g = makeGuard({ dirty: true, onSave: async () => true });
  g.guard(() => { left = true; });
  assert.equal(left, false, "the action is held, not run");
  assert.equal(g.asking, true);
});

await asyncTest("saving lets the held action through", async () => {
  let left = false;
  let saved = false;
  const g = makeGuard({ dirty: true, onSave: async () => { saved = true; return true; } });
  g.guard(() => { left = true; });
  await g.saveThenLeave();
  assert.equal(saved, true);
  assert.equal(left, true);
  assert.equal(g.asking, false);
});

await asyncTest("a failed save keeps the dialog up and the edits in place", async () => {
  let left = false;
  const g = makeGuard({ dirty: true, onSave: async () => false });
  g.guard(() => { left = true; });
  await g.saveThenLeave();
  assert.equal(left, false, "leaving now would discard what the save failed to keep");
  assert.equal(g.asking, true, "and the user still has to decide");
});

test("discarding runs the action without saving", () => {
  let left = false;
  let saved = false;
  const g = makeGuard({ dirty: true, onSave: async () => { saved = true; return true; } });
  g.guard(() => { left = true; });
  g.discardAndLeave();
  assert.equal(left, true);
  assert.equal(saved, false);
});

test("cancelling drops the action entirely", () => {
  let left = false;
  const g = makeGuard({ dirty: true, onSave: async () => true });
  g.guard(() => { left = true; });
  g.cancel();
  assert.equal(left, false);
  assert.equal(g.asking, false);
});

await asyncTest("answering twice runs the action once", async () => {
  let count = 0;
  const g = makeGuard({ dirty: true, onSave: async () => true });
  g.guard(() => { count++; });
  await g.saveThenLeave();
  await g.saveThenLeave();
  assert.equal(count, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
