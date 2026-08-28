// Tests for the splitter drag helper. Guards the two things the rAF coalescing must not
// change: the width computed for a given pointer position, and the fact that the LAST
// position of a drag always lands (dropping it would leave the pane a few pixels off
// where the user let go, and for the sidebar/pane splitters that width feeds the PTY cols).
// Run: node web/test/dragResize.test.mjs
import assert from "node:assert/strict";
import { widthAt, startWidthDrag } from "../shared/utils/dragResize.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// --- widthAt: the arithmetic the drag used to inline ---

test("dragging right widens an axis +1 element (sidebar, panes)", () => {
  assert.equal(widthAt({ startWidth: 200, startX: 500, x: 560, axis: 1 }), 260);
});

test("dragging left narrows an axis +1 element", () => {
  assert.equal(widthAt({ startWidth: 200, startX: 500, x: 460, axis: 1 }), 160);
});

test("axis -1 inverts it (right/editor/mobile panels grow leftward)", () => {
  assert.equal(widthAt({ startWidth: 200, startX: 500, x: 460, axis: -1 }), 240);
  assert.equal(widthAt({ startWidth: 200, startX: 500, x: 560, axis: -1 }), 140);
});

test("axis defaults to +1", () => {
  assert.equal(widthAt({ startWidth: 100, startX: 0, x: 30 }), 130);
});

test("no movement returns the starting width", () => {
  assert.equal(widthAt({ startWidth: 190, startX: 42, x: 42, axis: -1 }), 190);
});

test("matches the pre-coalescing formulas verbatim", () => {
  // sidebar/pane were `startW + ev.clientX - startX`
  assert.equal(widthAt({ startWidth: 190, startX: 100, x: 137, axis: 1 }), 190 + 137 - 100);
  // right/editor/mobile panels were `startW - (ev.clientX - startX)`
  assert.equal(widthAt({ startWidth: 420, startX: 100, x: 137, axis: -1 }), 420 - (137 - 100));
});

// --- startWidthDrag: coalescing must not lose the final position ---

// Minimal DOM/rAF stand-in: frames only run when the test says so, so "a frame is still
// pending at pointerup" is reproducible rather than timing-dependent.
function harness() {
  const listeners = {};
  let queued = null, nextId = 1;
  const widths = [];

  globalThis.document = {
    body: { style: {} },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    }
  };
  globalThis.requestAnimationFrame = (fn) => { queued = fn; return nextId++; };
  globalThis.cancelAnimationFrame = () => { queued = null; };

  return {
    widths,
    onWidth: (w) => widths.push(w),
    move: (x) => (listeners.pointermove || []).forEach((fn) => fn({ clientX: x })),
    up: () => (listeners.pointerup || []).slice().forEach((fn) => fn()),
    frame: () => { const fn = queued; queued = null; fn?.(); },
    pending: () => queued !== null,
    listenerCount: (type) => (listeners[type] || []).length
  };
}

test("many moves inside one frame commit once, at the latest position", () => {
  const h = harness();
  startWidthDrag({ preventDefault() {}, clientX: 100 }, { startWidth: 200, onWidth: h.onWidth });
  h.move(110); h.move(120); h.move(130);
  assert.deepEqual(h.widths, [], "nothing commits before the frame runs");
  h.frame();
  assert.deepEqual(h.widths, [230], "one commit, using the last position — not 210 or 220");
});

test("each frame commits once — a slow drag still tracks the pointer", () => {
  const h = harness();
  startWidthDrag({ preventDefault() {}, clientX: 0 }, { startWidth: 100, onWidth: h.onWidth });
  h.move(10); h.frame();
  h.move(25); h.frame();
  h.move(40); h.frame();
  assert.deepEqual(h.widths, [110, 125, 140]);
});

test("pointerup lands the final position when a frame is still queued", () => {
  const h = harness();
  startWidthDrag({ preventDefault() {}, clientX: 0 }, { startWidth: 300, onWidth: h.onWidth });
  h.move(50);
  assert.ok(h.pending(), "a frame is queued");
  h.up();
  assert.deepEqual(h.widths, [350], "the last pixels of the drag are not dropped");
});

test("pointerup after the frame already ran does not re-commit", () => {
  const h = harness();
  startWidthDrag({ preventDefault() {}, clientX: 0 }, { startWidth: 300, onWidth: h.onWidth });
  h.move(50);
  h.frame();
  h.up();
  assert.deepEqual(h.widths, [350], "exactly one commit, no duplicate on release");
});

test("a click with no movement commits nothing", () => {
  const h = harness();
  startWidthDrag({ preventDefault() {}, clientX: 80 }, { startWidth: 190, onWidth: h.onWidth });
  h.up();
  assert.deepEqual(h.widths, [], "no pointermove means no width change");
});

test("listeners and cursor styles are cleaned up on release", () => {
  const h = harness();
  startWidthDrag({ preventDefault() {}, clientX: 0 }, { startWidth: 100, onWidth: h.onWidth });
  assert.equal(h.listenerCount("pointermove"), 1);
  assert.equal(document.body.style.cursor, "col-resize");
  h.up();
  assert.equal(h.listenerCount("pointermove"), 0, "a leaked move listener would drag forever");
  assert.equal(h.listenerCount("pointerup"), 0);
  assert.equal(document.body.style.cursor, "");
  assert.equal(document.body.style.userSelect, "");
});

test("onEnd fires after the final commit, so resize flags clear last", () => {
  const h = harness();
  const order = [];
  startWidthDrag({ preventDefault() {}, clientX: 0 }, {
    startWidth: 100,
    onWidth: (w) => order.push(`width:${w}`),
    onEnd: () => order.push("end")
  });
  h.move(20);
  h.up();
  assert.deepEqual(order, ["width:120", "end"]);
});

test("onEnd is optional", () => {
  const h = harness();
  startWidthDrag({ preventDefault() {}, clientX: 0 }, { startWidth: 100, onWidth: h.onWidth });
  h.move(5);
  h.up(); // must not throw on a missing onEnd
  assert.deepEqual(h.widths, [105]);
});

test("preventDefault is called so the drag does not select text", () => {
  const h = harness();
  let prevented = false;
  startWidthDrag({ preventDefault() { prevented = true; }, clientX: 0 },
    { startWidth: 100, onWidth: h.onWidth });
  assert.ok(prevented);
  h.up();
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
