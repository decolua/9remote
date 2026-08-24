// Several clients (and several tabs of one client) hit the agent at once, all
// keyed on the same deviceId. The proof is per DEVICE, so they share one
// waiter list — these cover what that sharing must not break: one tab's
// deadline must not cancel another's, a settled proof must wake every waiter,
// and a refusal must wake none.
//
// Run: node --test agent/test/proofWaiters.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const home = mkdtempSync(join(tmpdir(), "9r-waiters-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, ".9remote"), { recursive: true });

const KEY = "sk-abcd1234-qrstuvwx-mnpqrstu";
const TAIL = "mnpqrstu";
writeFileSync(join(home, ".9remote", "keys.json"), JSON.stringify({ key: KEY }));

const { onTailProven, submitTailProof, clearProofWaiters } = await import("../lib/deviceAuth.js");

test("every tab waiting on one device is woken by a single proof", () => {
  const woken = [];
  for (const tab of ["t1", "t2", "t3"]) onTailProven("dev-multi", () => woken.push(tab));
  submitTailProof("dev-multi", TAIL);
  assert.deepEqual(woken, ["t1", "t2", "t3"]);
});

test("a refused proof wakes nobody — no tab may show the approval modal", () => {
  let woken = 0;
  onTailProven("dev-refused", () => { woken++; });
  onTailProven("dev-refused", () => { woken++; });
  submitTailProof("dev-refused", "wrongtail");
  assert.equal(woken, 0);
});

test("one tab's expiry does not cancel another tab's waiter", async () => {
  // Both tabs wait; the first is armed with a deadline, the second is not.
  // Firing the first must leave the second able to be woken by the proof.
  let expired = 0;
  let woken = 0;
  onTailProven("dev-expiry", () => { woken++; }, () => { expired++; });
  onTailProven("dev-expiry", () => { woken++; });
  submitTailProof("dev-expiry", TAIL);
  assert.equal(woken, 2, "both tabs woken by the proof");
  assert.equal(expired, 0, "no deadline fires once the proof landed");
});

test("waiters registered while a proof is being processed are not lost", () => {
  // A tab that re-arms from inside its own callback (a reconnect landing in the
  // same tick) must not be dropped by the flush that is running.
  let second = false;
  onTailProven("dev-rearm", () => {
    onTailProven("dev-rearm", () => { second = true; });
  });
  submitTailProof("dev-rearm", TAIL);
  // Already proven, so the re-armed waiter runs immediately rather than queueing.
  assert.equal(second, true);
});

test("clearing one device leaves other devices' waiters intact", () => {
  let a = false, b = false;
  onTailProven("dev-a", () => { a = true; });
  onTailProven("dev-b", () => { b = true; });
  clearProofWaiters("dev-a");
  submitTailProof("dev-a", TAIL);
  submitTailProof("dev-b", TAIL);
  assert.equal(a, false, "cleared device's waiter must not fire");
  assert.equal(b, true, "an unrelated device is unaffected");
});
