// Characterization tests for the remote-canvas geometry math extracted from useCanvas.
// Expected values replicate the pre-refactor inline formulas exactly.
// Run: node web/test/canvasGeometry.test.mjs
import assert from "node:assert/strict";
import {
  clamp, toCanvasPoint, toPercentPoint, maxPanFor, clampPan, fitScaleFor,
  zoomAtFocal, wheelModeMultiplier, accumulateScrollDelta, isDoubleClick,
  classifyGestureIntent, trackpadMultiplier, panWithEdgeOverflow,
  autoFollowPanAdjust, momentumStep, keyboardPanTarget, touchDistance, touchCenter
} from "../features/remote/lib/canvasGeometry.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const CFG = {
  doubleClickDelay: 300, moveThreshold: 10,
  momentumFriction: 0.94, momentumMinVelocity: 0.3,
  edgeScrollThreshold: 15, edgeScrollMultiplier: 1.5,
  gestureLockDelay: 80, gestureDistanceThreshold: 15, gestureCentroidThreshold: 10, gestureDominanceRatio: 2,
  trackpadSensitivity: 1.3, trackpadAcceleration: 1.5,
  wheelLineHeight: 40, wheelPageHeight: 400
};

test("toCanvasPoint reverses pan then scale", () => {
  const p = toCanvasPoint({ clientX: 250, clientY: 150, containerRect: { left: 50, top: 50 }, pan: { x: -100, y: -50 }, totalScale: 2 });
  // ((250-50) - (-100)) / 2 = 150 ; ((150-50) - (-50)) / 2 = 75
  assert.deepEqual(p, { x: 150, y: 75 });
});

test("toPercentPoint clamps to 0-100", () => {
  assert.deepEqual(toPercentPoint({ canvasPoint: { x: 960, y: 540 }, canvasWidth: 1920, canvasHeight: 1080 }), { percentX: 50, percentY: 50 });
  assert.deepEqual(toPercentPoint({ canvasPoint: { x: -50, y: 5000 }, canvasWidth: 1920, canvasHeight: 1080 }), { percentX: 0, percentY: 100 });
});

test("maxPanFor is zero-or-negative on both axes", () => {
  assert.deepEqual(maxPanFor({ width: 800, height: 600 }, { width: 1600, height: 1200 }), { x: -800, y: -600 });
  assert.deepEqual(maxPanFor({ width: 800, height: 600 }, { width: 400, height: 300 }), { x: 0, y: 0 });
});

test("clampPan keeps pan within [maxPan, 0]", () => {
  assert.deepEqual(clampPan({ x: -900, y: 100 }, { x: -800, y: -600 }), { x: -800, y: 0 });
});

test("fitScaleFor preserves aspect ratio (min of axes)", () => {
  assert.equal(fitScaleFor({ width: 800, height: 600 }, { width: 1600, height: 1200 }), 0.5);
  assert.equal(fitScaleFor({ width: 800, height: 400 }, { width: 1600, height: 1200 }), 0.3333333333333333);
});

test("zoomAtFocal keeps focal point fixed and clamps zoom to [1,4]", () => {
  const container = { width: 800, height: 600 };
  const base = { width: 800, height: 600 };
  const displaySizeAt = (z) => ({ width: base.width * z, height: base.height * z });
  // zoom 1 → 2 around focal (400,300): pan = focal - (focal - 0)*2 = -focal
  const r = zoomAtFocal({ prevZoom: 1, prevPan: { x: 0, y: 0 }, focal: { x: 400, y: 300 }, nextZoomRaw: 2, maxZoom: 4, containerSize: container, displaySizeAt });
  assert.equal(r.zoom, 2);
  assert.deepEqual(r.pan, { x: -400, y: -300 });
  // zoom capped at 4 → pan proportional
  const r2 = zoomAtFocal({ prevZoom: 1, prevPan: { x: 0, y: 0 }, focal: { x: 400, y: 300 }, nextZoomRaw: 9, maxZoom: 4, containerSize: container, displaySizeAt });
  assert.equal(r2.zoom, 4);
  assert.deepEqual(r2.pan, { x: -1200, y: -900 });
  // no-op zoom returns previous pan untouched
  const r3 = zoomAtFocal({ prevZoom: 4, prevPan: { x: -100, y: -100 }, focal: { x: 0, y: 0 }, nextZoomRaw: 5, maxZoom: 4, containerSize: container, displaySizeAt });
  assert.deepEqual(r3, { zoom: 4, pan: { x: -100, y: -100 } });
});

test("wheelModeMultiplier maps deltaMode 0/1/2", () => {
  assert.equal(wheelModeMultiplier(0, CFG), 1);
  assert.equal(wheelModeMultiplier(1, CFG), 40);
  assert.equal(wheelModeMultiplier(2, CFG), 400);
});

test("accumulateScrollDelta: below threshold accumulates, at threshold emits signed amount", () => {
  let r = accumulateScrollDelta({ accum: 0, delta: 10, threshold: 15, multiplier: 1.5 });
  assert.equal(r.scroll, null);
  assert.equal(r.accum, 10);
  r = accumulateScrollDelta({ accum: 10, delta: 10, threshold: 15, multiplier: 1.5 });
  assert.equal(r.scroll, 30); // round(20*1.5), positive → down-scroll input "up"
  assert.equal(r.accum, 0);
  r = accumulateScrollDelta({ accum: 0, delta: -20, threshold: 15, multiplier: 1.5 });
  assert.equal(r.scroll, -30);
});

test("isDoubleClick: time AND distance window", () => {
  const last = { time: 1000, pos: { x: 100, y: 100 } };
  assert.equal(isDoubleClick({ now: 1200, lastTime: last.time, lastPos: last.pos, x: 105, y: 108, cfg: CFG }), true);
  assert.equal(isDoubleClick({ now: 1400, lastTime: last.time, lastPos: last.pos, x: 105, y: 108, cfg: CFG }), false); // too late
  assert.equal(isDoubleClick({ now: 1200, lastTime: last.time, lastPos: last.pos, x: 120, y: 108, cfg: CFG }), false); // too far
});

test("classifyGestureIntent: no signal before lock delay → null", () => {
  assert.equal(classifyGestureIntent({ elapsed: 50, deltaDistance: 3, deltaCentroid: 2, cfg: CFG }), null);
});

test("classifyGestureIntent: dominant distance → zoom, dominant centroid → scroll", () => {
  assert.equal(classifyGestureIntent({ elapsed: 10, deltaDistance: 30, deltaCentroid: 2, cfg: CFG }), "zoom");
  assert.equal(classifyGestureIntent({ elapsed: 10, deltaDistance: 2, deltaCentroid: 30, cfg: CFG }), "scroll");
});

test("classifyGestureIntent: after lock delay, sole signal wins, ambiguous stays null", () => {
  assert.equal(classifyGestureIntent({ elapsed: 200, deltaDistance: 20, deltaCentroid: 0, cfg: CFG }), "zoom");
  assert.equal(classifyGestureIntent({ elapsed: 200, deltaDistance: 0, deltaCentroid: 20, cfg: CFG }), "scroll");
  assert.equal(classifyGestureIntent({ elapsed: 200, deltaDistance: 20, deltaCentroid: 20, cfg: CFG }), null); // ratio 1, both signals
});

test("trackpadMultiplier: accel = 1 + min(cap, speed*cap), mult = sens*accel", () => {
  // dx=3,dy=4 → dist 5 ; dt=5ms → speed 1 px/ms ; accel = 1+min(1.5, 1.5)=2.5 ; mult = 1.3*2.5
  assert.equal(trackpadMultiplier({ deltaX: 3, deltaY: 4, dt: 5, cfg: CFG }), 3.25);
  // speed 100 → capped at 1.5 → mult = 1.3*2.5
  assert.equal(trackpadMultiplier({ deltaX: 500, deltaY: 0, dt: 5, cfg: CFG }), 3.25);
  // speed 0 → mult = 1.3
  assert.equal(trackpadMultiplier({ deltaX: 0, deltaY: 0, dt: 5, cfg: CFG }), 1.3);
});

test("panWithEdgeOverflow: clamps pan, reports Y overflow only when stuck at edge", () => {
  const container = { width: 800, height: 600 };
  const display = { width: 1600, height: 1200 }; // maxPan = (-800, -600)
  // free move: pan shifts fully, no overflow
  let r = panWithEdgeOverflow({ prevPan: { x: 0, y: 0 }, deltaX: -100, deltaY: -100, containerSize: container, displaySize: display });
  assert.deepEqual(r.pan, { x: -100, y: -100 });
  assert.equal(r.overflowY, 0);
  // stuck at bottom edge (y=0, canvas taller than container): further down → overflow
  r = panWithEdgeOverflow({ prevPan: { x: 0, y: 0 }, deltaX: 0, deltaY: 80, containerSize: container, displaySize: display });
  assert.deepEqual(r.pan, { x: 0, y: 0 });
  assert.equal(r.overflowY, 80);
  // stuck at top edge (y=-600): further up → negative overflow
  r = panWithEdgeOverflow({ prevPan: { x: 0, y: -600 }, deltaX: 0, deltaY: -40, containerSize: container, displaySize: display });
  assert.equal(r.overflowY, -40);
});

test("autoFollowPanAdjust pushes pan toward cursor inside margin", () => {
  const container = { width: 400, height: 400 };
  const marginRatio = 0.15; // 60px margin
  // cursor at (0,0), pan (100,0): screenX=100 (past margin 60, inside) → no x adj;
  // screenY=0 (< margin 60) → push down by 60
  const adj = autoFollowPanAdjust({ cursor: { x: 0, y: 0 }, pan: { x: 100, y: 0 }, containerSize: container, displaySize: { width: 800, height: 800 }, totalScale: 1, marginRatio });
  assert.deepEqual(adj, { x: 0, y: 60 });
  // cursor past the right margin: screenX=380 > 400-60 → pull left
  const adjR = autoFollowPanAdjust({ cursor: { x: 380, y: 200 }, pan: { x: 0, y: 0 }, containerSize: container, displaySize: { width: 800, height: 800 }, totalScale: 1, marginRatio });
  assert.deepEqual(adjR, { x: -40, y: 0 });
  // cursor centered → no adjustment
  const adj2 = autoFollowPanAdjust({ cursor: { x: 200, y: 200 }, pan: { x: 0, y: 0 }, containerSize: container, displaySize: { width: 800, height: 800 }, totalScale: 1, marginRatio });
  assert.deepEqual(adj2, { x: 0, y: 0 });
});

test("momentumStep: null below min velocity, else scroll lines + decayed velocity", () => {
  assert.equal(momentumStep({ x: 0, y: 0.2 }, CFG), null);
  const r = momentumStep({ x: 0, y: 2 }, CFG);
  assert.equal(r.scrollY, 3); // round(2*1.5)
  assert.equal(r.nextVelocity.y, 1.88); // 2*0.94
});

test("keyboardPanTarget places focus 1/3 down the visible area", () => {
  assert.equal(keyboardPanTarget({ focus: { y: 100 }, containerHeight: 600, totalScale: 2 }).y, 0); // 200 - 200
  assert.equal(keyboardPanTarget({ focus: { y: 50 }, containerHeight: 600, totalScale: 2 }).y, 100); // 200 - 100
});

test("touchDistance/touchCenter over two touches", () => {
  const t = [{ clientX: 0, clientY: 0 }, { clientX: 30, clientY: 40 }];
  assert.equal(touchDistance(t), 50);
  assert.deepEqual(touchCenter(t), { x: 15, y: 20 });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
