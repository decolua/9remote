// Verifies statusIdle/Working/Blocked/Done keys exist in EVERY web locale, sit inside the
// `common` group, and resolve via the dot-path resolver used by useI18n (resolvePath splits on ".").
// Run: node web/test/i18n-status.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "shared", "i18n", "locales");
const KEYS = ["statusIdle", "statusWorking", "statusBlocked", "statusDone"];
const EXPECTED_LOCALES = ["ar", "de", "en", "es", "fa", "fr", "he", "hi", "id", "it", "ja", "ko", "ms", "nl", "pl", "pt", "ru", "sv", "th", "tr", "uk", "vi", "zh"];

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Resolve a dot-path inside a nested dict — mirrors web/shared/i18n/index.js resolvePath.
function resolvePath(dict, p) {
  return p.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), dict);
}

test("all 23 locale files are present", () => {
  for (const loc of EXPECTED_LOCALES) {
    assert.ok(fs.existsSync(path.join(LOCALES_DIR, `${loc}.js`)), `${loc}.js missing`);
  }
});

for (const loc of EXPECTED_LOCALES) {
  test(`${loc}: all 4 status keys present + resolve via common.* path`, async () => {
    const mod = await import(`../shared/i18n/locales/${loc}.js`);
    const dict = mod.default;
    for (const key of KEYS) {
      const value = resolvePath(dict, `common.${key}`);
      assert.ok(typeof value === "string" && value.length > 0, `common.${key} missing in ${loc}`);
    }
  });
}

test("keys are NOT duplicated outside common (no stray top-level status*)", async () => {
  for (const loc of EXPECTED_LOCALES) {
    const mod = await import(`../shared/i18n/locales/${loc}.js`);
    const dict = mod.default;
    for (const key of KEYS) {
      // Top-level (non-namespaced) would be a leftover from the first wrong insert pass.
      assert.equal(dict[key], undefined, `${loc}.js has stray top-level ${key}`);
    }
  }
});

console.log(`\n${fail ? `❌ ${fail} failed` : "✅ all passed"}, ${pass} passed`);
if (fail) process.exit(1);
