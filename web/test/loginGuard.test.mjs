// Admin login hardening — the pure decision functions. The D1 upserts are
// exercised by hand against the real binding; what must never regress silently
// is the tier math: which failure count delays, by how much, and that the SQL
// CASE lists tiers in the order that makes the harshest matching tier win.
//
// Run: node --import ./test/loader-alias.mjs web/test/loginGuard.test.mjs
import assert from "node:assert/strict";
import { ADMIN_LOGIN_LOCKS, ADMIN_LOGIN_DELAY_AFTER_FAILS, ADMIN_LOGIN_DELAY_MAX_MS } from "../features/admin/constants/index.js";
import { delayMsFor, ipLockKey, userLockKey } from "../features/admin/lib/loginGuard.js";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}

t("tiers are listed harshest-first so the first match wins", () => {
  const fails = ADMIN_LOGIN_LOCKS.map((x) => x.fails);
  for (let i = 1; i < fails.length; i++) {
    assert.ok(fails[i - 1] > fails[i], `tier ${i} must have a higher threshold than tier ${i - 1}`);
  }
});

t("lock thresholds and windows match the approved escalation 5/15m 10/1h 15/24h", () => {
  const map = Object.fromEntries(ADMIN_LOGIN_LOCKS.map((x) => [x.fails, x.minutes]));
  assert.equal(map[5], 15);
  assert.equal(map[10], 60);
  assert.equal(map[15], 24 * 60);
});

t("delay stays at zero below the account-wide threshold", () => {
  for (let f = 0; f < ADMIN_LOGIN_DELAY_AFTER_FAILS; f++) assert.equal(delayMsFor(f), 0);
});

t("delay doubles past the threshold and is capped", () => {
  assert.equal(delayMsFor(ADMIN_LOGIN_DELAY_AFTER_FAILS), 1000);
  assert.equal(delayMsFor(ADMIN_LOGIN_DELAY_AFTER_FAILS + 1), 2000);
  assert.equal(delayMsFor(ADMIN_LOGIN_DELAY_AFTER_FAILS + 2), 4000);
  assert.equal(delayMsFor(ADMIN_LOGIN_DELAY_AFTER_FAILS + 3), 8000);
  assert.equal(delayMsFor(ADMIN_LOGIN_DELAY_AFTER_FAILS + 4), ADMIN_LOGIN_DELAY_MAX_MS);
  assert.equal(delayMsFor(ADMIN_LOGIN_DELAY_AFTER_FAILS + 50), ADMIN_LOGIN_DELAY_MAX_MS);
});

t("lock keys separate dimensions and normalise username case", () => {
  assert.equal(ipLockKey("1.2.3.4"), "ip:1.2.3.4");
  assert.equal(userLockKey("Root"), userLockKey("root"));
  assert.notEqual(userLockKey("root"), ipLockKey("root"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
