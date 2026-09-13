// Swipe-to-switch-tabs must stand down when the touch starts inside a box that pans
// sideways. The bug it fixes: a wide code block in the AI chat scrolls horizontally,
// and the same drag cleared the swipe threshold — scrolling the block flipped the pane.
//
// Run: node --import ./test/loader-alias.mjs web/test/swipeTabScroller.test.mjs
import assert from "node:assert/strict";
import { startsInScrollerX } from "../features/terminal/hooks/useSwipeTab.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// A minimal node: parent chain plus the two widths the check reads.
const node = (overflowX, { scrollWidth = 500, clientWidth = 300, parent = null } = {}) => ({
  nodeType: 1,
  overflowX,
  scrollWidth,
  clientWidth,
  parentElement: parent
});

const withOverflow = (el) => (n) => n.overflowX;

test("overflowing code block blocks the swipe", () => {
  const code = node("auto");
  assert.equal(startsInScrollerX(code, withOverflow(code)), true);
});

test("a code block that fits does not block it", () => {
  const code = node("auto", { scrollWidth: 300, clientWidth: 300 });
  assert.equal(startsInScrollerX(code, withOverflow(code)), false);
});

test("overflow hidden does not block — it cannot be panned", () => {
  const box = node("hidden");
  assert.equal(startsInScrollerX(box, withOverflow(box)), false);
});

test("overflow visible does not block", () => {
  const box = node("visible");
  assert.equal(startsInScrollerX(box, withOverflow(box)), false);
});

test("an ancestor scroller is found from a nested span", () => {
  const code = node("auto");
  const span = node("visible", { parent: code });
  assert.equal(startsInScrollerX(span, withOverflow(span)), true);
});

test("an overflowing ancestor blocks even when the target itself is plain", () => {
  const outer = node("auto", { scrollWidth: 900, clientWidth: 300 });
  const inner = node("visible", { scrollWidth: 100, clientWidth: 100, parent: outer });
  assert.equal(startsInScrollerX(inner, withOverflow(inner)), true);
});

test("a non-overflowing ancestor does not block", () => {
  const outer = node("auto", { scrollWidth: 300, clientWidth: 300 });
  const inner = node("visible", { parent: outer });
  assert.equal(startsInScrollerX(inner, withOverflow(inner)), false);
});

test("scroll (not just auto) counts", () => {
  const box = node("scroll");
  assert.equal(startsInScrollerX(box, withOverflow(box)), true);
});

test("plain chat text leaves the swipe alone", () => {
  const p = node("visible");
  assert.equal(startsInScrollerX(p, withOverflow(p)), false);
});

test("a detached target does not throw", () => {
  assert.equal(startsInScrollerX(null, () => "auto"), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
