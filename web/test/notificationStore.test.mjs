import assert from "node:assert/strict";
import { useConnectionStore } from "../shared/stores/connectionStore.js";
import { useNotificationStore } from "../shared/stores/notificationStore.js";

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

await test("initial state is empty maps", () => {
  useNotificationStore.getState().reset();
  const { notifications, sessionStatus } = useNotificationStore.getState();
  assert.deepEqual(notifications, {});
  assert.deepEqual(sessionStatus, {});
});

await test("handleStatusChange for 'done' adds badge and updates sessionStatus", () => {
  useNotificationStore.getState().reset();
  useNotificationStore.getState().handleStatusChange({
    sessionId: "s1",
    state: "done",
    tool: "bash",
    since: 1000
  });

  const { notifications, sessionStatus } = useNotificationStore.getState();
  assert.deepEqual(notifications.s1, { sessionId: "s1", type: "done", tool: "bash", timestamp: 1000 });
  assert.deepEqual(sessionStatus.s1, { state: "done", tool: "bash", since: 1000 });
});

await test("handleStatusChange for 'working' does not add badge", () => {
  useNotificationStore.getState().reset();
  useNotificationStore.getState().handleStatusChange({
    sessionId: "s2",
    state: "working",
    tool: "edit",
    since: 2000
  });

  const { notifications, sessionStatus } = useNotificationStore.getState();
  assert.equal(notifications.s2, undefined);
  assert.equal(sessionStatus.s2?.state, "working");
});

await test("clearNotification clears badge, resets state to idle (preserving tool), emits clear", () => {
  const emits = [];
  const fakeBus = {
    emit: (event, arg) => emits.push({ event, arg })
  };
  useConnectionStore.getState().setConnection({ bus: fakeBus, busRef: { current: fakeBus }, connected: true });

  useNotificationStore.getState().reset();
  useNotificationStore.getState().handleStatusChange({
    sessionId: "s1",
    state: "done",
    tool: "bash",
    since: 1000
  });

  useNotificationStore.getState().clearNotification("s1");
  const { notifications, sessionStatus } = useNotificationStore.getState();
  assert.equal(notifications.s1, undefined, "badge should be removed");
  assert.equal(sessionStatus.s1?.state, "idle", "status should become idle");
  assert.equal(sessionStatus.s1?.tool, "bash", "tool icon must be preserved");

  assert.equal(emits.length, 2);
  assert.deepEqual(emits[0], { event: "clearNotification", arg: "s1" });
  assert.deepEqual(emits[1], { event: "clearStatus", arg: "s1" });

  // Calling again immediately is a no-op (no duplicate emits)
  useNotificationStore.getState().clearNotification("s1");
  assert.equal(emits.length, 2, "must not double emit");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
