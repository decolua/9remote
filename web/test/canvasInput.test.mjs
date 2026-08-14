// Characterization tests for the canvas input-mode modules extracted from useCanvas.
// Fake ctx (refs + spies) + synthetic touch/mouse events — no React, no DOM.
// Run: node --import ./test/loader-alias.mjs web/test/canvasInput.test.mjs
import assert from "node:assert/strict";
import { handleMouseEvent } from "../features/remote/lib/canvasInput/mouseMode.js";
import { handleTrackpadEvent } from "../features/remote/lib/canvasInput/trackpadMode.js";
import { handleTouchEvent } from "../features/remote/lib/canvasInput/touchMode.js";

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push(Promise.resolve().then(() => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}));

const spy = (impl) => {
  const fn = (...a) => { fn.calls.push(a); return fn.impl ? fn.impl(...a) : undefined; };
  fn.calls = [];
  fn.impl = impl;
  return fn;
};
const ref = (v) => ({ current: v });

const CANVAS = { width: 1000, height: 600 };
const HANDLERS = { emitMouseClick: spy(), emitMousePress: spy(), emitMouseRelease: spy(), emitMouseMove: spy(), emitScroll: spy(), emitBoostStream: spy() };

function makeCtx(over = {}) {
  const ctx = {
    canvasRef: ref(CANVAS),
    canvasContainerRef: ref({ clientWidth: 1000, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    socketEmitFunctions: HANDLERS,
    getCanvasCoordinates: (x, y) => ({ percentX: x / 10, percentY: y / 6 }),
    displaySizeAt: (z) => ({ width: 1000 * z, height: 600 * z }),
    containerSize: () => ({ width: 1000, height: 600 }),
    cursorPercent: (c, cv) => ({ percentX: (c.x / cv.width) * 100, percentY: (c.y / cv.height) * 100 }),
    emitVirtualCursor: spy(),
    emitScrollFromDelta: spy(),
    emitHScrollFromDelta: spy(),
    showClickIndicator: spy(),
    cancelLongPress: spy(),
    startLongPress: spy(),
    checkDoubleClick: spy(() => false),
    stopMomentum: spy(),
    startMomentumScroll: spy(),
    // viewport state
    canvasZoom: 1, canvasPan: { x: 0, y: 0 }, fitScale: 1, virtualCursor: { x: 500, y: 300 },
    setCanvasZoom: spy(), setCanvasPan: spy(), setVirtualCursor: spy(),
    // gesture state
    isZooming: false, isPanning: false, isEdgeScrolling: false, recentZoomGesture: false,
    lastTouchDistance: 0, lastTouchCenter: { x: 0, y: 0 },
    setIsZooming: spy(), setIsPanning: spy(), setIsEdgeScrolling: spy(), setRecentZoomGesture: spy(),
    setLastTouchDistance: spy(), setLastTouchCenter: spy(),
    // refs
    gestureLockRef: ref(null), gestureStartRef: ref({ time: Date.now(), distance: 0, centerX: 0, centerY: 0 }),
    multiTouchLatchRef: ref(false), twoFingerMaxMovedRef: ref(0),
    longPressTimerRef: ref(null), longPressTriggeredRef: ref(false), touchStartPosRef: ref({ x: 0, y: 0 }),
    lastClickTimeRef: ref(0), lastClickPosRef: ref({ x: 0, y: 0 }),
    edgeScrollAccumRef: ref({ x: 0, y: 0 }), velocityRef: ref({ x: 0, y: 0 }),
    lastTouchTimeRef: ref(Date.now()), momentumFrameRef: ref(null),
    touchStartTimeRef: ref(0), touchTotalMoveRef: ref(0),
    handLongPressTimerRef: ref(null), handHoldingRef: ref(false), setHandHolding: spy(),
    scrollLongPressTimerRef: ref(null), scrollLockRef: ref(false), setScrollLock: spy(),
    mouseDownButtonRef: ref(null), wheelAccumRef: ref({ x: 0, y: 0 }),
    wheelActiveRef: ref(false), wheelEndTimerRef: ref(null), wheelLastBoostRef: ref(0),
    zoomGestureTimeoutRef: ref(null),
    ...over
  };
  return ctx;
}
const OPTS = { streaming: true };
const clear = () => Object.values(HANDLERS).forEach((h) => { h.calls = []; });
const touchEv = (touches, extra = {}) => ({ type: "touchmove", touches, changedTouches: touches, nativeEvent: { pointerType: "touch" }, preventDefault: spy(), ...extra });

// ── mouseMode ─────────────────────────────────────────────────────────────────
test("mouse: pointerdown/move/up drag sequence (button map 2 → right)", () => {
  clear();
  const ctx = makeCtx();
  handleMouseEvent(ctx, { button: 2, clientX: 100, clientY: 60 }, "pointerdown", OPTS);
  assert.deepEqual(HANDLERS.emitMousePress.calls[0], [10, 10, "right"]);
  handleMouseEvent(ctx, { button: 2, clientX: 200, clientY: 120 }, "pointermove", OPTS);
  assert.equal(HANDLERS.emitMouseMove.calls.length, 1, "move forwarded while held");
  handleMouseEvent(ctx, { button: 2, clientX: 300, clientY: 180 }, "pointerup", OPTS);
  assert.deepEqual(HANDLERS.emitMouseRelease.calls[0], [30, 30, "right"]);
  // move without button held → not forwarded
  handleMouseEvent(ctx, { button: 0, clientX: 400, clientY: 240 }, "pointermove", OPTS);
  assert.equal(HANDLERS.emitMouseMove.calls.length, 1);
});

test("mouse: wheel burst boosts once, flips deltaY sign, accumulates horizontal", () => {
  clear();
  const ctx = makeCtx();
  handleMouseEvent(ctx, { deltaY: 40, deltaX: 0, deltaMode: 0, clientX: 100, clientY: 60, type: "wheel" }, "wheel", OPTS);
  assert.equal(HANDLERS.emitBoostStream.calls.length, 1, "boost once per burst");
  assert.equal(HANDLERS.emitMouseMove.calls.length, 1, "mouseMove once per burst");
  assert.deepEqual(ctx.emitScrollFromDelta.calls, [[-100]], "deltaY 40 * mult 2.5, sign flipped");
  // second wheel in same burst: no re-boost, scroll continues
  handleMouseEvent(ctx, { deltaY: 40, deltaX: 0, deltaMode: 0, clientX: 100, clientY: 60, type: "wheel" }, "wheel", OPTS);
  assert.equal(HANDLERS.emitBoostStream.calls.length, 1);
  assert.equal(ctx.emitScrollFromDelta.calls.length, 2);
});

test("mouse: ctrl+wheel zooms via zoomAtFocal, clamped to [1,4]", () => {
  clear();
  // zoom-in at cap 4 → no-op (updater returns prev, no pan update)
  const capped = makeCtx({ canvasZoom: 4 });
  handleMouseEvent(capped, { deltaY: -100, ctrlKey: true, deltaMode: 0, clientX: 500, clientY: 300, type: "wheel" }, "wheel", OPTS);
  assert.equal(capped.setCanvasZoom.calls[0][0](4), 4);
  assert.equal(capped.setCanvasPan.calls.length, 0, "no pan update on no-op zoom");
  // zoom-in from 1 → 1.1, pan recomputed via zoomAtFocal
  const ctx = makeCtx({ canvasZoom: 1 });
  handleMouseEvent(ctx, { deltaY: -100, ctrlKey: true, deltaMode: 0, clientX: 500, clientY: 300, type: "wheel" }, "wheel", OPTS);
  assert.equal(ctx.setCanvasZoom.calls[0][0](1), 1.1);
  assert.equal(ctx.setCanvasPan.calls.length, 1);
  // zoom-out from 4 → 3.9
  const out = makeCtx({ canvasZoom: 4 });
  handleMouseEvent(out, { deltaY: 100, ctrlKey: true, deltaMode: 0, clientX: 500, clientY: 300, type: "wheel" }, "wheel", OPTS);
  assert.equal(out.setCanvasZoom.calls[0][0](4), 3.9);
});

test("mouse: contextmenu → right click; dblclick → no emit", () => {
  clear();
  const ctx = makeCtx();
  handleMouseEvent(ctx, { button: 2, clientX: 100, clientY: 60, type: "contextmenu" }, "contextmenu", OPTS);
  assert.deepEqual(HANDLERS.emitMouseClick.calls[0], [10, 10, "right"]);
  handleMouseEvent(ctx, { button: 0, clientX: 100, clientY: 60, type: "dblclick" }, "dblclick", OPTS);
  assert.equal(HANDLERS.emitMouseClick.calls.length, 1, "dblclick adds no third click");
});

// ── trackpadMode ──────────────────────────────────────────────────────────────
test("trackpad: 2-finger falls through; latched multi-touch falls through", () => {
  const ctx = makeCtx();
  const two = touchEv([{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 200 }]);
  assert.equal(handleTrackpadEvent(ctx, two, "touchmove", { ...OPTS, pointerMode: "trackpad" }), false);
  ctx.multiTouchLatchRef.current = true;
  const one = touchEv([{ clientX: 100, clientY: 100 }]);
  assert.equal(handleTrackpadEvent(ctx, one, "touchmove", { ...OPTS, pointerMode: "trackpad" }), false);
});

test("trackpad: tap → click at virtual cursor percent", () => {
  clear();
  const ctx = makeCtx({ touchStartTimeRef: ref(Date.now() - 50), touchTotalMoveRef: ref(2) });
  const end = touchEv([{ clientX: 500, clientY: 300 }], { type: "touchend", touches: [] });
  assert.equal(handleTrackpadEvent(ctx, end, "touchend", { ...OPTS, pointerMode: "trackpad" }), true);
  assert.deepEqual(HANDLERS.emitMouseClick.calls[0], [50, 50, "left", false], "cursor (500,300)/canvas 1000x600 → 50%,50%");
});

test("trackpad: scroll lock drag scrolls, cursor stays frozen", () => {
  clear();
  const ctx = makeCtx({ scrollLockRef: ref(true), lastTouchCenter: { x: 100, y: 100 }, lastTouchTimeRef: ref(Date.now()) });
  handleTrackpadEvent(ctx, touchEv([{ clientX: 130, clientY: 160 }]), "touchmove", { ...OPTS, pointerMode: "trackpad" });
  assert.deepEqual(ctx.emitScrollFromDelta.calls, [[60]], "deltaY 60 forwarded");
  assert.deepEqual(ctx.emitHScrollFromDelta.calls, [[30]]);
  assert.equal(ctx.setVirtualCursor.calls.length, 0, "cursor frozen");
});

test("trackpad: hand mode touchend releases hold", () => {
  clear();
  const ctx = makeCtx({ handHoldingRef: ref(true) });
  const end = touchEv([{ clientX: 500, clientY: 300 }], { type: "touchend", touches: [] });
  handleTrackpadEvent(ctx, end, "touchend", { ...OPTS, pointerMode: "trackpad", handMode: true });
  assert.deepEqual(HANDLERS.emitMouseRelease.calls[0], [50, 50, "left"]);
  assert.equal(ctx.handHoldingRef.current, false);
});

// ── touchMode ─────────────────────────────────────────────────────────────────
test("touch: 2-finger start arms gesture state; zoom-locked pinch pans+zooms", () => {
  clear();
  const ctx = makeCtx({ canvasZoom: 2, lastTouchDistance: 100 });
  handleTouchEvent(ctx, touchEv([{ clientX: 100, clientY: 300 }, { clientX: 200, y: 300, clientY: 300 }], { type: "touchstart", touches: [{ clientX: 100, clientY: 300 }, { clientX: 200, clientY: 300 }] }), "touch", OPTS);
  assert.equal(ctx.setIsZooming.calls[0][0], true);
  // pinch out: distance 100 → 200 at zoom 2 → clamped to 4
  const move = touchEv([{ clientX: 50, clientY: 300 }, { clientX: 250, clientY: 300 }]);
  ctx.gestureLockRef.current = "zoom";
  ctx.isZooming = true;
  handleTouchEvent(ctx, move, "touchmove", OPTS);
  assert.equal(ctx.setCanvasZoom.calls[0][0], 4);
  assert.equal(ctx.setCanvasPan.calls.length, 1, "pan updater scheduled");
});

test("touch: scroll-locked 2-finger move anchors once then scrolls", () => {
  clear();
  const ctx = makeCtx({ lastTouchCenter: { x: 150, y: 150 } });
  ctx.gestureLockRef.current = "scroll";
  ctx.isZooming = true;
  handleTouchEvent(ctx, touchEv([{ clientX: 100, clientY: 180 }, { clientX: 200, clientY: 180 }]), "touchmove", OPTS);
  assert.equal(HANDLERS.emitBoostStream.calls.length, 1, "anchored once");
  assert.equal(HANDLERS.emitMouseMove.calls.length, 1);
  assert.deepEqual(ctx.emitScrollFromDelta.calls, [[30]], "centroid deltaY 30");
});

test("touch: zoom>1 pan overflows at edge → scroll; free pan → no scroll", () => {
  clear();
  const ctx = makeCtx({ canvasZoom: 2, lastTouchCenter: { x: 500, y: 300 }, displaySizeAt: () => ({ width: 2000, height: 1200 }) });
  const ev = touchEv([{ clientX: 500, clientY: 400 }]); // deltaY +100 downward
  // free move: pan shifts, no overflow
  handleTouchEvent(ctx, ev, "touchmove", OPTS);
  const updater = ctx.setCanvasPan.calls[0][0];
  const r = updater({ x: -500, y: -300 });
  assert.deepEqual(r, { x: -500, y: -200 }, "pan follows finger (deltaY +100 down), clamped");
  assert.equal(ctx.emitScrollFromDelta.calls.length, 0);
  // stuck at top edge (y=-600 max): upward move → overflow
  const up = touchEv([{ clientX: 500, clientY: 200 }]);
  ctx.lastTouchCenter = { x: 500, y: 400 };
  handleTouchEvent(ctx, up, "touchmove", OPTS);
  const updater2 = ctx.setCanvasPan.calls[1][0];
  const r2 = updater2({ x: -600, y: -600 });
  assert.equal(r2.y, -600, "pan stuck at edge");
  assert.equal(ctx.emitScrollFromDelta.calls.length, 1, "overflow forwarded to scroll");
});

test("touch: touchend click after plain tap; long-press suppresses click", () => {
  clear();
  const ctx = makeCtx();
  const end = touchEv([{ clientX: 100, clientY: 60 }], { type: "touchend", touches: [] });
  handleTouchEvent(ctx, end, "touchend", OPTS);
  assert.deepEqual(HANDLERS.emitMouseClick.calls[0], [10, 10, "left", false]);
  clear();
  ctx.longPressTriggeredRef.current = true;
  handleTouchEvent(ctx, end, "touchend", OPTS);
  assert.equal(HANDLERS.emitMouseClick.calls.length, 0, "long-press already right-clicked");
});

test("touch: 2-finger tap in trackpad mode right-clicks at cursor", () => {
  clear();
  const ctx = makeCtx({ isZooming: true, gestureStartRef: ref({ time: Date.now() - 50 }), twoFingerMaxMovedRef: ref(3) });
  handleTouchEvent(ctx, touchEv([], { type: "touchend", touches: [] }), "touchend", { ...OPTS, pointerMode: "trackpad" });
  assert.deepEqual(HANDLERS.emitMouseClick.calls[0], [50, 50, "right"]);
});

test("touch: click/move fallback emits at mapped percent", () => {
  clear();
  const ctx = makeCtx();
  handleTouchEvent(ctx, { clientX: 100, clientY: 60, type: "click" }, "click", { ...OPTS, isMobile: false });
  assert.deepEqual(HANDLERS.emitMouseClick.calls[0], [10, 10, "left", false]);
  handleTouchEvent(ctx, { clientX: 100, clientY: 60, type: "mousemove" }, "move", { ...OPTS, isMobile: false });
  assert.equal(HANDLERS.emitMouseMove.calls.length, 1);
  // mobile → no hover move
  handleTouchEvent(ctx, { clientX: 100, clientY: 60, type: "mousemove" }, "move", { ...OPTS, isMobile: true });
  assert.equal(HANDLERS.emitMouseMove.calls.length, 1);
});

await Promise.all(tests);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
