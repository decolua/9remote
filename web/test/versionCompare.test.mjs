// isNewer — the honesty gate for a reported update: only an offered version
// AHEAD of the running one counts.

import assert from "node:assert/strict";
import { isNewer } from "../shared/utils/versionCompare.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("\n--- isNewer (version honesty gate) ---");

test("equal versions are NOT an update (the stale-flag case)", () => {
  assert.equal(isNewer("1.2.34", "1.2.34"), false);
});

test("older offered than running is not an update", () => {
  assert.equal(isNewer("1.2.33", "1.2.34"), false);
});

test("patch/minor/major bumps are updates", () => {
  assert.equal(isNewer("1.2.35", "1.2.34"), true);
  assert.equal(isNewer("1.3.0", "1.2.34"), true);
  assert.equal(isNewer("2.0.0", "1.9.9"), true);
});

test("missing either side is never an update", () => {
  assert.equal(isNewer(null, "1.2.34"), false);
  assert.equal(isNewer("1.2.35", null), false);
  assert.equal(isNewer(undefined, undefined), false);
});

test("uneven segment counts compare numerically", () => {
  assert.equal(isNewer("1.2", "1.1.9"), true);
  assert.equal(isNewer("1.2.0", "1.2"), false);
});

console.log(fail === 0 ? `\n✅ ${pass} passed, ${fail} failed` : `\n❌ ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
