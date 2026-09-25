// Admission state in connectionStore — the verdict transitions that used to
// live as hook-local state, plus the re-key reset semantics (reset clears
// admission but keeps authKey: a dropped connection is not a host switch).

import assert from "node:assert/strict";
import { useConnectionStore } from "../shared/stores/connectionStore.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log("\n--- Admission state (connectionStore) ---");

const cs = () => useConnectionStore.getState();

await test("pending → approved → pending is a stale late signal (stays approved)", () => {
  useConnectionStore.setState({ approvalStatus: null, admitted: false });
  cs().applyApproval("pending");
  assert.equal(cs().approvalStatus, "pending");
  cs().applyApproval("approved");
  assert.equal(cs().approvalStatus, "approved");
  cs().applyApproval("pending");
  assert.equal(cs().approvalStatus, "approved", "late pending must not demote an approval");
});

await test("reconnect keeps a standing approval, clears anything less", () => {
  useConnectionStore.setState({ approvalStatus: "approved" });
  cs().applyApproval("reconnect");
  assert.equal(cs().approvalStatus, null);
  useConnectionStore.setState({ approvalStatus: "pending" });
  cs().applyApproval("reconnect");
  assert.equal(cs().approvalStatus, "pending");
});

await test("reset() drops admission but keeps authKey", () => {
  useConnectionStore.setState({ authKey: "head1", approvalStatus: "approved", admitted: true, connected: true });
  cs().reset();
  assert.equal(cs().approvalStatus, null);
  assert.equal(cs().admitted, false);
  assert.equal(cs().authKey, "head1", "a dropped connection must not look like a host switch");
});

console.log(fail === 0 ? `\n✅ ${pass} passed, ${fail} failed` : `\n❌ ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
