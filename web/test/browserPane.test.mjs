// Remote browser pane — pure helpers self-check.
// Run: node --import ./test/loader-alias.mjs test/browserPane.test.mjs
import assert from "node:assert/strict";
import { viewportPoint } from "../features/browser/lib/pointerMap.js";
import { cleanTabTitle, useBrowserStore } from "../shared/stores/browserStore.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("cleanTabTitle strips the engine's 🚀 stamp", () => {
  assert.equal(cleanTabTitle("🚀 [2] My Page"), "My Page");
  assert.equal(cleanTabTitle("🚀 [12]"), "");
  assert.equal(cleanTabTitle("Plain title"), "Plain title");
  assert.equal(cleanTabTitle(null), "");
});

test("viewportPoint maps image px to viewport CSS px", () => {
  const rect = { width: 400, height: 800 };
  const meta = { deviceWidth: 800, deviceHeight: 1600, scale: 1 };
  const p = viewportPoint(100, 200, rect, meta);
  assert.equal(p.x, 200);
  assert.equal(p.y, 400);
});

test("viewportPoint divides by pinch scale", () => {
  const p = viewportPoint(0, 0, { width: 400, height: 800 }, { deviceWidth: 800, deviceHeight: 1600, scale: 2 });
  assert.equal(p.x, 0);
  const half = viewportPoint(200, 400, { width: 400, height: 800 }, { deviceWidth: 800, deviceHeight: 1600, scale: 2 });
  assert.equal(half.x, 200);
  assert.equal(half.y, 400);
});

test("viewportPoint falls back to the rect when meta is missing", () => {
  const p = viewportPoint(50, 100, { width: 100, height: 200 }, null);
  assert.equal(p.x, 50);
  assert.equal(p.y, 100);
});

test("browserStore setTabs/setActive", () => {
  useBrowserStore.getState().setTabs([{ id: "A", title: "x" }]);
  assert.equal(useBrowserStore.getState().tabs.length, 1);
  useBrowserStore.getState().setTabs(null);
  assert.equal(useBrowserStore.getState().tabs.length, 0);
  useBrowserStore.getState().setActive("A");
  assert.equal(useBrowserStore.getState().activeTargetId, "A");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
