// Regression test for the tab-strip "click twice" bug: WebKit (Tauri WKWebView) drops the
// pointerup when a release is captured, and the stale drag used to swallow the next click.
// Run: node web/test/dragReorderRecovery.test.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";

// The hook imports through the web app's "@/…" alias and real React — map the alias back to
// web/ and stub React with the two primitives the hook uses (no renderer in node).
const REACT_STUB = `
let cursor = 0;
export const resetState = () => { cursor = 0; };
export const useRef = (init) => ({ current: typeof init === "function" ? init() : init });
export const useCallback = (fn) => fn;
export const useState = (init) => {
  const i = cursor++;
  const slots = globalThis.__state;
  if (slots[i] === undefined) slots[i] = init;
  return [slots[i], (v) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }];
};
globalThis.__resetState = resetState;
`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "react") return { url: `data:text/javascript,${encodeURIComponent(REACT_STUB)}`, shortCircuit: true };
    if (!spec.startsWith("@/")) return next(spec, ctx);
    const base = new URL(`../${spec.slice(2)}`, import.meta.url);
    return next((existsSync(base) ? base : new URL(`${base}.js`)).href, ctx);
  }
});
const { useDragReorder } = await import("../features/terminal/hooks/useDragReorder.js");

// ── Fake DOM + window ──────────────────────────────────────────────────────
globalThis.__state = [];

const listeners = new Map();
globalThis.window = {
  addEventListener: (t, fn) => listeners.set(t, [...(listeners.get(t) || []), fn]),
  removeEventListener: (t, fn) => listeners.set(t, (listeners.get(t) || []).filter((f) => f !== fn))
};
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.setTimeout = () => 1;
globalThis.clearTimeout = () => {};

const fire = (type, ev) => [...(listeners.get(type) || [])].forEach((fn) => fn(ev));

// Two fixed-width tabs side by side.
const els = new Map([
  ["a", { getBoundingClientRect: () => ({ left: 0, width: 100 }), style: {}, setPointerCapture() { this.captured = true; }, releasePointerCapture() { this.released = true; } }],
  ["b", { getBoundingClientRect: () => ({ left: 100, width: 100 }), style: {}, setPointerCapture() { this.captured = true; }, releasePointerCapture() { this.released = true; } }]
]);
const IDS = ["a", "b"];
const down = (id, x) => ({ pointerType: "mouse", button: 0, pointerId: 7, clientX: x, preventDefault() {}, currentTarget: els.get(id) });
const move = (x) => ({ pointerType: "mouse", buttons: 1, pointerId: 7, clientX: x });

const newHook = (onCommit) => {
  globalThis.__resetState();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- node test, hook called directly
  const hook = useDragReorder({ axis: "x", threshold: 6, onCommit });
  hook.registerEl("a")(els.get("a"));
  hook.registerEl("b")(els.get("b"));
  return hook;
};

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  finally {
    listeners.clear();
    els.forEach((el) => { el.style = {}; el.released = false; el.captured = false; });
    globalThis.__state.length = 0;
  }
};

test("drag whose release is lost does not swallow the next tab click", () => {
  const committed = [];
  const hook = newHook((next) => committed.push(next));

  hook.startDrag(down("a", 10), "a", IDS);
  fire("pointermove", move(120)); // past the threshold — the drag is live
  fire("pointermove", move(130)); // release dropped: no pointerup ever arrives
  assert.deepEqual(committed, [], "a drag that never ended must not commit");

  // Next press on another tab: the stale drag must not eat that tab's click.
  hook.startDrag(down("b", 150), "b", IDS);
  assert.equal(hook.consumeClick(), false, "stale drag swallowed the next tab click");
  assert.equal(els.get("a").released, true, "capture of the abandoned drag was not released");

  // …and the new drag still reorders normally.
  fire("pointermove", move(20));
  fire("pointerup", {});
  assert.deepEqual(committed, [["b", "a"]], "recovered drag did not reorder");
});

test("a drag that DID end still swallows its own release click", () => {
  const hook = newHook(() => {});

  hook.startDrag(down("a", 10), "a", IDS);
  fire("pointermove", move(120));
  fire("pointerup", {}); // a real release — the click right after it is the drag's, not a switch

  assert.equal(hook.consumeClick(), true, "the drag's own release click leaked into a tab switch");
});

test("a click with no drags at all is never eaten", () => {
  const hook = newHook(() => {});
  assert.equal(hook.consumeClick(), false, "a plain click after an ended drag was swallowed");
});

// The capture is what triggers WebKit bug 202287, so it must be taken on movement only:
// capturing on pointerdown costs the user the NEXT click, even when they never dragged.
test("a press that never moves takes no pointer capture", () => {
  const hook = newHook(() => {});
  hook.startDrag(down("a", 10), "a", IDS);
  fire("pointerup", {});
  assert.equal(els.get("a").captured, false, "a plain click captured the pointer and will eat the next one");
});

test("a moved drag takes pointer capture", () => {
  const hook = newHook(() => {});
  hook.startDrag(down("a", 10), "a", IDS);
  fire("pointermove", move(120));
  assert.equal(els.get("a").captured, true, "a live drag did not capture — pointerup outside the element would be lost");
  fire("pointerup", {});
});

test("a plain click is never eaten", () => {
  const committed = [];
  const hook = newHook((next) => committed.push(next));

  hook.startDrag(down("a", 10), "a", IDS);
  fire("pointermove", move(12)); // below the 6px threshold
  fire("pointerup", {});
  assert.equal(hook.consumeClick(), false, "a plain click was swallowed");
  assert.equal(hook.dragId, null);
  assert.deepEqual(committed, []);
});

test("a moved drag swallows exactly one click", () => {
  const hook = newHook(() => {});
  hook.startDrag(down("a", 10), "a", IDS);
  fire("pointermove", move(120));
  fire("pointerup", {});
  assert.equal(hook.consumeClick(), true, "the release click was not swallowed");
  assert.equal(hook.consumeClick(), false, "the flag did not clear after one click");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
