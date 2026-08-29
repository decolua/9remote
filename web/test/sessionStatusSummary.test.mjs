// What the notification badge counts and where a tap lands. The count is the whole
// signal on mobile — the user acts on the number without opening anything — so an
// off-by-one or a tap landing on the wrong terminal is the failure that matters.
// Run: node web/test/sessionStatusSummary.test.mjs
import assert from "node:assert/strict";
import { attentionSummary, statusItems } from "../features/terminal/lib/sessionStatusSummary.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

test("only waiting and finished sessions are counted", () => {
  const s = attentionSummary({
    a: { state: "blocked" }, b: { state: "done" }, c: { state: "working" }, d: { state: "idle" }
  }, sessions);
  assert.equal(s.blocked, 1);
  assert.equal(s.done, 1);
  assert.equal(s.total, 2, "working and idle raise no badge");
});

test("nothing to report yields a zero total, so the badge can hide", () => {
  const s = attentionSummary({ a: { state: "working" }, b: { state: "idle" } }, sessions);
  assert.equal(s.total, 0);
  assert.equal(s.targetId, null);
});

test("a session with no entry at all counts as idle", () => {
  assert.equal(attentionSummary({}, sessions).total, 0);
});

test("a tap goes to a session waiting on the user before one that has finished", () => {
  const s = attentionSummary({ a: { state: "done", since: 99 }, b: { state: "blocked", since: 1 } }, sessions);
  assert.equal(s.targetId, "b", "waiting outranks finished regardless of age");
});

test("among equals the most recent is the one a tap lands on", () => {
  const s = attentionSummary({ a: { state: "blocked", since: 10 }, b: { state: "blocked", since: 50 } }, sessions);
  assert.equal(s.targetId, "b");
});

test("a status for a session that no longer exists is ignored", () => {
  const s = attentionSummary({ gone: { state: "blocked" }, a: { state: "done" } }, sessions);
  assert.equal(s.blocked, 0, "the closed session raises nothing");
  assert.equal(s.targetId, "a");
});

test("without a session list the status map alone still answers", () => {
  // The bell renders before sessions load; it must not blank out meanwhile.
  const s = attentionSummary({ x: { state: "blocked" } }, []);
  assert.equal(s.blocked, 1);
  assert.equal(s.targetId, "x");
});

test("items come back with the ones needing attention first", () => {
  const items = statusItems({ a: { state: "idle" }, b: { state: "done" }, c: { state: "working" } }, sessions);
  assert.deepEqual(items.map((i) => i.state), ["working", "done", "idle", "idle"]);
});

test("the tool a session runs survives the merge", () => {
  const [first] = statusItems({ a: { state: "blocked", tool: "claude" } }, sessions);
  assert.equal(first.tool, "claude");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
