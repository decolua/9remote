// Paging older turns in must not move what the reader is looking at.
//
// Reported from a phone: scroll-up jumped around and lost the place. The correction used
// to be `scrollTop += (scrollHeight_after - scrollHeight_before)` with the fetch awaited
// in between, so it counted two things that are not the page — the browser clamping
// `scrollTop` when content is prepended, and the live turn still streaming into the tail.
//
// Run: cd web && node --import ./test/loader-alias.mjs test/aiScrollAnchor.test.mjs
import assert from "node:assert/strict";
import { anchorFrom, anchoredScrollTop } from "../features/ai/lib/scrollAnchor.js";

let pass = 0, fail = 0;
const test = (n, f) => {
  try { f(); pass++; console.log(`  ok  ${n}`); }
  catch (e) { fail++; console.error(`  FAIL ${n}\n       ${e.message}`); }
};

// The `after` readings below are what the scroller reports ONCE THE NEW CONTENT IS IN THE
// DOM. Writing it out beats a helper: the numbers are the whole test, and a builder that
// computed them from the same arithmetic under test would prove nothing.
//
//   scrollTop    what the browser left it at after re-clamping the enlarged scroll height
//   scrollHeight the old height plus whatever mounted above AND whatever streamed below
//   nodeTop      the anchor node, pushed down the content by exactly what was prepended
const afterPage = (prepended, tailGrew, scrollTop) => ({
  scrollTop, scrollHeight: 5000 + prepended + tailGrew, clientHeight: 800, nodeTop: 3000 + prepended
});

// A scroller 800px tall showing part of a 5000px conversation, 3000px down. The anchor
// node — the turn at the top of the mounted window — sits 3000px into the content, which
// is exactly the top edge of the viewport.
const before = { scrollTop: 3000, scrollHeight: 5000, clientHeight: 800, nodeTop: 3000 };

test("a page prepended above holds the reader exactly where they were", () => {
  const a = anchorFrom(before);
  // 1000px of older turns mounted above: the node is pushed 1000px down the content, so
  // the reader must gain exactly 1000 of scrollTop to stay on it.
  const after = afterPage(1000, 0, 3000);
  assert.equal(anchoredScrollTop(a, after), 4000, "3000 + the 1000 that arrived above");
  // The node is back on the same pixel of the screen, which is the property that matters:
  // its viewport offset is `nodeTop - scrollTop`, and that is what the correction preserves.
  assert.equal(after.nodeTop - 4000, a.nodeTop - a.scrollTop, "same pixel of the screen as before");
});

test("the live turn streaming into the tail does not move the reader", () => {
  // The bug: the fetch takes seconds, the agent keeps writing. 2000px appears BELOW the
  // viewport, so scrollHeight grows to 7000 while nothing above moves at all.
  const a = anchorFrom(before);
  assert.equal(anchoredScrollTop(a, afterPage(0, 2000, 3000)), null, "nothing to correct — leave the scroller alone");
});

test("a page above AND a streaming tail at once corrects only the page", () => {
  // The case the old code got wrong in both directions: it added the whole 3000px delta
  // (1000 prepended + 2000 streamed) and the reader landed 2000px past where they were.
  const a = anchorFrom(before);
  assert.equal(anchoredScrollTop(a, afterPage(1000, 2000, 3000)), 4000, "1000 above, 2000 below, +1000 only");
});

test("the answer is always inside the scroll range, however big the page", () => {
  // No clamp and no read-back afterwards, and this is why: the node's new position and the
  // scroll height both grow by what was prepended, so the distance from the node to the end
  // of the content cannot shrink. The write is in range by construction.
  const a = anchorFrom(before);
  for (const prepended of [400, 1000, 4000, 50000]) {
    const after = afterPage(prepended, 0, 3000);
    const top = anchoredScrollTop(a, after);
    assert.equal(top, 3000 + prepended, `a ${prepended}px page lands the node where it was`);
    assert.ok(top <= after.scrollHeight - after.clientHeight,
      `${top} must not be past the end of a ${after.scrollHeight}px scroller`);
  }
});

test("a reader at the bottom stays at the bottom", () => {
  const a = anchorFrom({ scrollTop: 4200, scrollHeight: 5000, clientHeight: 800, nodeTop: 4200 });
  assert.equal(a.atBottom, true, "under 8px from the end is the bottom");
  assert.equal(anchoredScrollTop(a, { scrollHeight: 6000, clientHeight: 800, nodeTop: 5200 }), 6000,
    "paging at open, or a reader who never left — re-pin rather than correct");
});

test("a page that mounted below the node is not a correction", () => {
  // The node can only move DOWN the content for a page prepended above it. Anything else is
  // not this correction's business, and writing a `scrollTop` for it would move a reader
  // who had not been moved.
  const a = anchorFrom(before);
  assert.equal(anchoredScrollTop(a, { scrollHeight: 7000, clientHeight: 800, nodeTop: 3000 }), null,
    "the tail grew, the node did not move");
  assert.equal(anchoredScrollTop(a, { scrollHeight: 5000, clientHeight: 800, nodeTop: 2000 }), null,
    "and a scroll the reader made upwards is theirs, not ours");
});

test("the correction is idempotent — running it twice is not two corrections", () => {
  // The pane runs it once per commit, and a second call can arrive from the scroll handler
  // before the flag update lands. Both read the same moved node, so both answer the same
  // number: the second write is a no-op rather than a second shift.
  const a = anchorFrom(before);
  const after = afterPage(1000, 0, 3000);
  const first = anchoredScrollTop(a, after);
  assert.equal(anchoredScrollTop(a, after), first, "same inputs, same answer — nothing compounds");
});

test("an unmounted node corrects nothing", () => {
  // The pane looks the node up by key after the page lands. A turn that is no longer
  // mounted (the window moved past it) reads as no node at all, and guessing an offset
  // from a missing one is how a correction turns into a jump.
  assert.equal(anchoredScrollTop(anchorFrom(before), {}), null);
  assert.equal(anchoredScrollTop(null, afterPage(1000, 0, 3000)), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
