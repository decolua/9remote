// A pane's background is a per-session pick if there is one, otherwise its slot in
// the global pool. Both sides can go stale (a custom image deleted on another
// device), and a stale key that survives would paint the canvas transparent over
// nothing — so the fallback chain is the whole point of this function.
// Run: cd web && node --import ./test/loader-alias.mjs test/paneBackgroundResolve.test.mjs
import assert from "node:assert/strict";
import { resolvePaneBackground } from "../features/terminal/constants/terminalConfig.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const CUSTOM = [{ id: "bg1", dataUrl: "data:image/jpeg;base64,AA" }];
const POOL = ["art1", "art2"];

test("no session pick falls through to the pool slot", () => {
  assert.equal(resolvePaneBackground(undefined, POOL, [], 0), "art1");
  assert.equal(resolvePaneBackground(undefined, POOL, [], 1), "art2");
  assert.equal(resolvePaneBackground(undefined, POOL, [], 2), "art1");
});

test("session pick overrides the pool slot", () => {
  assert.equal(resolvePaneBackground("art2", POOL, [], 0), "art2");
});

test("an empty pool with no pick renders nothing", () => {
  assert.equal(resolvePaneBackground(undefined, [], [], 0), "none");
});

test("session pick of none is honoured, not treated as absent", () => {
  assert.equal(resolvePaneBackground("none", POOL, [], 0), "none");
});

test("a deleted custom pick falls back to the pool slot", () => {
  assert.equal(resolvePaneBackground("custom:gone", POOL, CUSTOM, 1), "art2");
});

test("a live custom pick wins", () => {
  assert.equal(resolvePaneBackground("custom:bg1", POOL, CUSTOM, 1), "custom:bg1");
});

test("stale pool slots are pruned before round-robin", () => {
  // art2 in the pool but index 1 would land on it if pruning did not happen first
  assert.equal(resolvePaneBackground(undefined, ["custom:gone", "art2"], CUSTOM, 1), "art2");
});

test("a deleted custom pick with a deleted pool renders nothing", () => {
  assert.equal(resolvePaneBackground("custom:gone", ["custom:gone"], CUSTOM, 0), "none");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
