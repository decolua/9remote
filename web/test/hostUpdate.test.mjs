// Per-host self-update state: requestHostUpdate guards + the update fields'
// lifecycle across a fleet entry (badge data in, updating flag out).

import assert from "node:assert/strict";
import { useConnectionStore } from "../shared/stores/connectionStore.js";
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

console.log("\n--- Host self-update (fleet store) ---");

const HEAD = "updhead";
const resetHost = (patch = {}) => useFleetStore.setState({
  currentKey: HEAD,
  hosts: { [HEAD]: { key: HEAD, full: null, label: "", status: "full", carrier: "ws", sessions: [], workspaces: [], statusMap: {}, platform: null, version: "1.0.0", lastSeenAt: null, updateAvailable: null, canSelfUpdate: false, updating: false, ...patch } }
});

const emitted = [];
let updatingWidened = 0;
const fakeBus = { connected: true, emit: (ev) => emitted.push(ev) };
const fakePm = { setUpdating: (on) => { if (on) updatingWidened++; } };

await test("unknown host: requestHostUpdate is a no-op", () => {
  resetHost();
  useFleetStore.getState().requestHostUpdate("nope");
  assert.equal(useFleetStore.getState().hosts.nope, undefined);
});

await test("active host: emits on the workspace connection and marks updating", () => {
  resetHost();
  emitted.length = 0;
  useConnectionStore.setState({ busRef: { current: fakeBus }, protocolRef: { current: fakePm } });
  useFleetStore.getState().requestHostUpdate(HEAD, "update");
  const h = useFleetStore.getState().hosts[HEAD];
  assert.equal(h.updating, true);
  assert.deepEqual(emitted, ["requestUpdate"]);
  assert.equal(updatingWidened, 1);
});

await test("already updating: second request is ignored", () => {
  resetHost({ updating: true });
  emitted.length = 0;
  useFleetStore.getState().requestHostUpdate(HEAD, "update");
  assert.deepEqual(emitted, []);
});

await test("active host offline (no live bus): nothing emitted, no flag", () => {
  resetHost();
  emitted.length = 0;
  useConnectionStore.setState({ busRef: { current: null }, protocolRef: { current: fakePm } });
  useFleetStore.getState().requestHostUpdate(HEAD, "restart");
  assert.deepEqual(emitted, []);
  assert.equal(useFleetStore.getState().hosts[HEAD].updating, false);
});

await test("serverInfo patch carries update fields into the entry", () => {
  resetHost({ updateAvailable: { version: "1.0.1" }, canSelfUpdate: false });
  useFleetStore.getState()._patchHost(HEAD, { updateAvailable: null, canSelfUpdate: true });
  const h = useFleetStore.getState().hosts[HEAD];
  assert.equal(h.updateAvailable, null);
  assert.equal(h.canSelfUpdate, true);
});

console.log(fail === 0 ? `\n✅ ${pass} passed, ${fail} failed` : `\n❌ ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
