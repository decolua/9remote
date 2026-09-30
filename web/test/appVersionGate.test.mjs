// The update gate's block decision runs on every mobile shell load — a wrong
// compare either bricks good apps or waves outdated ones through. The rule:
// numeric part-by-part compare, unparsable minimum fails open, and a shell
// that reports no version at all is treated as outdated (upstream of this
// file, in AppUpdateGate).
// Run: node --import ./test/loader-alias.mjs test/appVersionGate.test.mjs
import assert from "node:assert/strict";
import { isMobileAppUA, appVersionOf, isVersionBelow } from "@/shared/lib/appVersionGate.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("detects the shell UA, rejects browsers", () => {
  assert.equal(isMobileAppUA("9Remote-Mobile/2.4.1"), true);
  assert.equal(isMobileAppUA("Mozilla/5.0 (Linux; Android 16) Chrome/141"), false);
  assert.equal(isMobileAppUA(""), false);
  assert.equal(isMobileAppUA(undefined), false);
});

test("version comes from DEVICE_INFO first, UA as fallback, null when absent", () => {
  assert.equal(appVersionOf("9Remote-Mobile/2.4.1", null), "2.4.1");
  assert.equal(appVersionOf("junk", { version: "2.4.2" }), "2.4.2");
  assert.equal(appVersionOf("9Remote-Mobile/2.4.1", { version: "2.4.2" }), "2.4.2");
  assert.equal(appVersionOf("Mozilla/5.0", null), null);
  assert.equal(appVersionOf("9Remote-Mobile/2.4.1", { version: "garbage" }), "2.4.1");
});

test("compare: below/equal/above across part counts", () => {
  assert.equal(isVersionBelow("2.4.1", "2.4.2"), true);
  assert.equal(isVersionBelow("2.4.2", "2.4.2"), false);
  assert.equal(isVersionBelow("2.5.0", "2.4.9"), false);
  assert.equal(isVersionBelow("2.4", "2.4.1"), true);      // 2.4 == 2.4.0
  assert.equal(isVersionBelow("3.0", "2.99.99"), false);
  assert.equal(isVersionBelow("2.10.0", "2.9.0"), false);  // numeric, not lexicographic
});

test("unparsable minimum fails open", () => {
  assert.equal(isVersionBelow("1.0.0", "banana"), false);
  assert.equal(isVersionBelow("banana", "1.0.0"), false);
  assert.equal(isVersionBelow("2.4.1", ""), false);
});

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nAll ${pass} passed`);
process.exit(fail ? 1 : 0);
