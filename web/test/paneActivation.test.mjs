// The pane pointer rule protects two behaviours that are invisible until they break:
// tapping a control must not steal pane focus, and a tap on dead space must not blur
// the focused input (which drops the soft keyboard on iOS).
//
// Run: node web/test/paneActivation.test.mjs
import assert from "node:assert/strict";
import { panePointerHandler } from "../shared/utils/paneActivation.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Minimal stand-in for a DOM event: only closest() and the two flags are read.
const makeEvent = (type, closestHits = []) => {
  const seen = { prevented: false, stopped: false };
  return {
    type,
    target: { closest: (sel) => (closestHits.includes(sel) ? { sel } : null) },
    preventDefault: () => { seen.prevented = true; },
    stopPropagation: () => { seen.stopped = true; },
    seen,
  };
};

const CONTROL = "button,a,label,select,[role='dialog'],[data-pane-control]";
const FIELD = "input, textarea";

test("control: never activates, swallows the event", () => {
  let activated = 0;
  const e = makeEvent("mousedown", [CONTROL]);
  panePointerHandler(e, { isFocused: false, onActivate: () => activated++ });
  assert.equal(activated, 0, "a button must not activate the pane");
  assert.equal(e.seen.prevented, true);
  assert.equal(e.seen.stopped, true);
});

test("control: does not activate an already-focused pane either", () => {
  let activated = 0;
  const e = makeEvent("mousedown", [CONTROL]);
  panePointerHandler(e, { isFocused: true, onActivate: () => activated++ });
  assert.equal(activated, 0);
});

test("empty space of an unfocused pane: activates", () => {
  let activated = 0;
  const e = makeEvent("mousedown", []);
  panePointerHandler(e, { isFocused: false, onActivate: () => activated++ });
  assert.equal(activated, 1);
});

test("empty space of a focused pane: no re-activation", () => {
  let activated = 0;
  const e = makeEvent("mousedown", []);
  panePointerHandler(e, { isFocused: true, onActivate: () => activated++ });
  assert.equal(activated, 0);
});

test("mouse-down on dead space keeps its default (drag-to-select)", () => {
  const e = makeEvent("mousedown", []);
  panePointerHandler(e, { isFocused: true, onActivate: () => {} });
  assert.equal(e.seen.prevented, false);
});

test("touch on dead space prevents the blur that closes the keyboard", () => {
  const e = makeEvent("touchstart", []);
  panePointerHandler(e, { isFocused: true, onActivate: () => {} });
  assert.equal(e.seen.prevented, true);
});

test("touch on a text field keeps the default so it can focus", () => {
  let activated = 0;
  const e = makeEvent("touchstart", [FIELD]);
  panePointerHandler(e, { isFocused: false, onActivate: () => activated++ });
  assert.equal(activated, 1, "tapping the input is a request to be there");
  assert.equal(e.seen.prevented, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
