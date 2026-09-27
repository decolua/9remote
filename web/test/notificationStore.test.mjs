import assert from "node:assert/strict";
import { useConnectionStore } from "../shared/stores/connectionStore.js";
import { useNotificationStore } from "../shared/stores/notificationStore.js";
import { useFleetStore } from "../shared/stores/fleetStore.js";

// New contract: badges live here, session status lives in each host's fleet
// entry. The paired writes below mirror useNotification's event handlers —
// notificationStore first (badge, reading the PRE-event map for tool carry),
// then fleetStore's applyStatusChange (the single status lane).
const HEAD = "testhead";
const HOST = { key: HEAD, full: null, label: "", status: "full", carrier: "ws", sessions: [], workspaces: [], statusMap: {}, platform: null, version: null, lastSeenAt: null };

const setupHost = () => useFleetStore.setState({ currentKey: HEAD, hosts: { [HEAD]: { ...HOST, statusMap: {} } } });
const statusChange = (p) => {
  useNotificationStore.getState().handleStatusChange(p);
  useFleetStore.getState().applyStatusChange(HEAD, p);
};
const statusOf = (id) => useFleetStore.getState().hosts[HEAD]?.statusMap?.[id];

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

await test("initial state is an empty badge map", () => {
  useNotificationStore.getState().reset();
  setupHost();
  assert.deepEqual(useNotificationStore.getState().notifications, {});
  assert.equal("sessionStatus" in useNotificationStore.getState(), false);
});

await test("handleStatusChange for 'done' adds a badge and applyStatusChange records the state", () => {
  useNotificationStore.getState().reset();
  setupHost();
  statusChange({ sessionId: "s1", state: "done", tool: "bash", since: 1000 });

  const { notifications } = useNotificationStore.getState();
  assert.deepEqual(notifications.s1, { sessionId: "s1", type: "done", tool: "bash", timestamp: 1000 });
  assert.deepEqual(statusOf("s1"), { state: "done", tool: "bash", since: 1000 });
});

await test("handleStatusChange for 'working' does not add a badge", () => {
  useNotificationStore.getState().reset();
  setupHost();
  statusChange({ sessionId: "s2", state: "working", tool: "edit", since: 2000 });

  assert.equal(useNotificationStore.getState().notifications.s2, undefined);
  assert.equal(statusOf("s2")?.state, "working");
});

await test("clearNotification clears the badge and emits clear once; idle arrives via the host's statusCleared", () => {
  const emits = [];
  const fakeBus = { emit: (event, arg) => emits.push({ event, arg }) };
  useConnectionStore.getState().setConnection({ bus: fakeBus, busRef: { current: fakeBus }, connected: true });

  useNotificationStore.getState().reset();
  setupHost();
  statusChange({ sessionId: "s1", state: "done", tool: "bash", since: 1000 });

  useNotificationStore.getState().clearNotification("s1");
  assert.equal(useNotificationStore.getState().notifications.s1, undefined, "badge should be removed");

  // One emit only: clearStatus is the single door (the host's own broadcast covers the
  // notification side), so this does not fetch state twice per clear.
  assert.equal(emits.length, 1);
  assert.deepEqual(emits[0], { event: "clearStatus", arg: "s1" });

  // The host's broadcast flips the state to idle, preserving the tool icon.
  useFleetStore.getState().applyStatusCleared(HEAD, "s1");
  assert.equal(statusOf("s1")?.state, "idle");
  assert.equal(statusOf("s1")?.tool, "bash");

  // Calling again immediately is a no-op (no duplicate emits)
  useNotificationStore.getState().clearNotification("s1");
  assert.equal(emits.length, 1, "must not double emit");
});

await test("clearNotification leaves a blocked session alone (a pending approval is still pending)", () => {
  const emits = [];
  const fakeBus = { emit: (event, arg) => emits.push({ event, arg }) };
  useConnectionStore.getState().setConnection({ bus: fakeBus, busRef: { current: fakeBus }, connected: true });

  useNotificationStore.getState().reset();
  setupHost();
  statusChange({ sessionId: "s1", state: "blocked", tool: "claude", since: 1000 });

  useNotificationStore.getState().clearNotification("s1");
  assert.equal(useNotificationStore.getState().notifications.s1?.type, "blocked", "badge must survive");
  assert.equal(statusOf("s1")?.state, "blocked", "status must survive");
  assert.equal(emits.length, 0, "must not tell the host to clear what it will refuse");
});

await test("applyStatusChange with tool: null clears the tool", () => {
  useNotificationStore.getState().reset();
  setupHost();
  statusChange({ sessionId: "s1", state: "working", tool: "claude", since: 1000 });
  assert.equal(statusOf("s1")?.tool, "claude");

  statusChange({ sessionId: "s1", state: "idle", tool: null, since: 1050 });
  assert.equal(statusOf("s1")?.tool, null, "tool should be cleared to null");
});

await test("a statusChange without a tool keeps the previous tool (carry-over)", () => {
  useNotificationStore.getState().reset();
  setupHost();
  statusChange({ sessionId: "s1", state: "working", tool: "claude", since: 1000 });
  statusChange({ sessionId: "s1", state: "done", since: 1100 });
  assert.equal(statusOf("s1")?.tool, "claude", "tool must carry over when the payload omits it");
});

await test("applyStatusState replaces the map, applyStatusCleared is a no-op for unknown ids", () => {
  useNotificationStore.getState().reset();
  setupHost();
  useFleetStore.getState().applyStatusState(HEAD, { s1: { state: "working", tool: "bash", since: 1 } });
  assert.equal(statusOf("s1")?.state, "working");
  useFleetStore.getState().applyStatusCleared(HEAD, "nope");
  assert.equal(statusOf("nope"), undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
