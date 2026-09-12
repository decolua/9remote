// scopeForOrigin + tailOfSecret are pure and decide which Cloudflare account a
// client's credentials come from — a wrong answer leaks a prod key to a dev
// page (or the reverse) and the relay silently stops working for that origin.
//
// Run: node web/test/turnKeys.test.mjs
import assert from "node:assert/strict";
import { scopeForOrigin, tailOfSecret, TURN_SCOPES } from "../features/admin/lib/turnKeys.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};


test("dev-prefixed host → dev scope", () => {
  assert.equal(scopeForOrigin("https://dev.9remote.cc"), "dev");
  assert.equal(scopeForOrigin("https://dev.9remote.cc:443"), "dev");
});
test("prod host → prod scope", () => {
  assert.equal(scopeForOrigin("https://9remote.cc"), "prod");
  assert.equal(scopeForOrigin("https://sites.9remote.cc"), "prod");
});
test("localhost dev server → dev scope", () => {
  assert.equal(scopeForOrigin("http://localhost:3000"), "dev");
  assert.equal(scopeForOrigin("http://127.0.0.1:3000"), "dev");
  assert.equal(scopeForOrigin("http://[::1]:3000"), "dev");
});
test("unknown or missing origin → prod scope", () => {
  assert.equal(scopeForOrigin("https://evil.example"), "prod");
  assert.equal(scopeForOrigin(null), "prod");
  assert.equal(scopeForOrigin(""), "prod");
  assert.equal(scopeForOrigin("not a url"), "prod");
});
test("tailOfSecret shows only the last 4 chars", () => {
  assert.equal(tailOfSecret("abcdefgh1234"), "…1234");
  assert.equal(tailOfSecret(""), "");
  assert.equal(tailOfSecret(null), "");
});
test("scopes are exactly dev/prod/both", () => {
  assert.deepEqual(TURN_SCOPES, ["dev", "prod", "both"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
