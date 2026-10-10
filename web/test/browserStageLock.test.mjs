// Soft-keyboard stage lock: on mobile the browser pane keeps its stage (and so
// the stream canvas) at the keyboard-closed height instead of shrink-fitting
// into the collapsed viewport — the "remote becomes tiny" bug — and the
// screencast must NOT restart across a keyboard open/close cycle. Pure state
// machine, no DOM.
// Run: node --import ./test/loader-alias.mjs test/browserStageLock.test.mjs
import assert from "node:assert/strict";
import { nextStageLock, shouldRestartStream } from "../features/browser/lib/stageLock.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("first observation seeds the true size, no lock", () => {
  const s = nextStageLock(null, { w: 375, h: 780 });
  assert.deepEqual(s, { width: 375, height: 780, lockedH: null, kbShrunk: false });
});

test("same-width height drop = soft keyboard → lock at closed height", () => {
  let s = nextStageLock(null, { w: 375, h: 780 });
  s = nextStageLock(s, { w: 375, h: 640 }); // keyboard animating in
  assert.equal(s.kbShrunk, true);
  assert.equal(s.lockedH, 780);
  assert.equal(s.height, 780); // TRUE size unchanged
  s = nextStageLock(s, { w: 375, h: 350 }); // fully open
  assert.equal(s.lockedH, 780);
  assert.equal(s.height, 780);
});

test("height back within tolerance unlocks", () => {
  let s = nextStageLock(null, { w: 375, h: 780 });
  s = nextStageLock(s, { w: 375, h: 350 });
  s = nextStageLock(s, { w: 375, h: 778 }); // near-closed is good enough
  assert.equal(s.kbShrunk, false);
  assert.equal(s.lockedH, null);
  assert.equal(s.height, 780);
});

test("sub-threshold jitter is noise, no lock", () => {
  let s = nextStageLock(null, { w: 375, h: 780 });
  s = nextStageLock(s, { w: 375, h: 776 }); // within 8px, above 2px tolerance gap
  assert.equal(s.kbShrunk, false);
  assert.equal(s.lockedH, null);
  assert.equal(s.height, 780);
});

test("width change (rotation) re-seeds even mid-shrink", () => {
  let s = nextStageLock(null, { w: 375, h: 780 });
  s = nextStageLock(s, { w: 375, h: 350 }); // keyboard open
  s = nextStageLock(s, { w: 812, h: 340 }); // rotate while open
  assert.deepEqual(s, { width: 812, height: 340, lockedH: null, kbShrunk: false });
});

test("growing never ratchets the max down, growth raises it", () => {
  let s = nextStageLock(null, { w: 375, h: 780 });
  s = nextStageLock(s, { w: 375, h: 779 }); // tolerant close, slightly lower
  assert.equal(s.height, 780);
  s = nextStageLock(s, { w: 375, h: 900 }); // real growth (fullscreen)
  assert.equal(s.height, 900);
  assert.equal(s.kbShrunk, false);
});

test("a full keyboard cycle does not restart the stream", () => {
  let s = nextStageLock(null, { w: 375, h: 780 });
  const before = { w: s.width, h: s.height };
  s = nextStageLock(s, { w: 375, h: 350 });
  s = nextStageLock(s, { w: 375, h: 780 });
  const after = { w: s.width, h: s.height };
  assert.equal(shouldRestartStream(before, after), false);
});

test("real size changes restart the stream (24px slack)", () => {
  assert.equal(shouldRestartStream({ w: 375, h: 780 }, { w: 375, h: 500 }), true);
  assert.equal(shouldRestartStream({ w: 375, h: 780 }, { w: 812, h: 375 }), true);
  assert.equal(shouldRestartStream({ w: 375, h: 780 }, { w: 375, h: 790 }), false);
  assert.equal(shouldRestartStream(null, { w: 375, h: 780 }), false);
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : `\nAll ${pass} passed`);
process.exitCode = fail ? 1 : 0;
