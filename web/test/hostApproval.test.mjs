// Per-host device admission: the fleet entry carries the verdict, a plain
// disconnect clears it, and a rejection keeps it for the row's retry/remove.

import assert from "node:assert/strict";
import { useFleetStore } from "../shared/stores/fleetStore.js";

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

console.log("\n--- Host admission (fleet store) ---");

const HEAD = "apvhead";
const resetHost = (patch = {}) => useFleetStore.setState({
  currentKey: "other",
  hosts: { [HEAD]: { key: HEAD, full: null, label: "", status: "online", carrier: "ws", sessions: [], workspaces: [], statusMap: {}, platform: null, version: null, lastSeenAt: null, updateAvailable: null, canSelfUpdate: false, updating: false, approval: null, ...patch } }
});

await test("entry defaults carry approval: null", () => {
  resetHost();
  assert.equal(useFleetStore.getState().hosts[HEAD].approval, null);
});

await test("pending verdict persists on the entry", () => {
  resetHost();
  useFleetStore.getState()._patchHost(HEAD, { approval: "pending" });
  assert.equal(useFleetStore.getState().hosts[HEAD].approval, "pending");
});

await test("rejection keeps its verdict through _closeHost", () => {
  resetHost();
  useFleetStore.getState()._closeHost(HEAD, { approval: "rejected" });
  const h = useFleetStore.getState().hosts[HEAD];
  assert.equal(h.status, "offline");
  assert.equal(h.approval, "rejected");
});

await test("a plain close clears a stale verdict (cancel must not keep the notice)", () => {
  resetHost({ approval: "pending" });
  useFleetStore.getState()._closeHost(HEAD);
  const h = useFleetStore.getState().hosts[HEAD];
  assert.equal(h.status, "offline");
  assert.equal(h.approval, null);
});

console.log(fail === 0 ? `\n✅ ${pass} passed, ${fail} failed` : `\n❌ ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
