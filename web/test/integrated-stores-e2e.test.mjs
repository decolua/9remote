// Integrated E2E test: connectionStore + fileBusStore + notificationStore
// Simulates full app lifecycle: connect -> working/done status -> file browse -> background drop -> reconnect -> action & clear

import assert from "node:assert/strict";
import { useConnectionStore } from "../shared/stores/connectionStore.js";
import { useFileBusStore } from "../shared/stores/fileBusStore.js";
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

console.log("\n--- Integrated E2E: Stores & Lifecycle ---");

await test("Full cycle: connect -> notifications -> files -> carrier drop -> reconnect -> clean up", async () => {
  const busEmits = [];
  const fakeBus = {
    emit: (event, payload, cb) => {
      busEmits.push({ event, payload });
      if (event === "getFiles") cb?.({ success: true, files: [{ name: "index.js", path: "/app/index.js" }] });
      if (event === "clearNotification") cb?.({ success: true });
      if (event === "clearStatus") cb?.({ success: true });
    }
  };

  // 1. Initial connect
  useConnectionStore.getState().setConnection({
    bus: fakeBus,
    busRef: { current: fakeBus },
    connected: true,
    carrier: "ws"
  });
  assert.equal(useConnectionStore.getState().connected, true);

  // 2. AI agent finishes a task in session 1
  useNotificationStore.getState().handleStatusChange({
    sessionId: "session-1",
    state: "done",
    tool: "bash",
    since: 1700000000
  });
  assert.equal(useNotificationStore.getState().notifications["session-1"]?.type, "done");
  assert.equal(useNotificationStore.getState().sessionStatus["session-1"]?.state, "done");

  // 3. User browses file tree
  const fileRes = await useFileBusStore.getState().getFiles("/app");
  assert.equal(fileRes.success, true);
  assert.equal(fileRes.files[0].name, "index.js");

  // 4. Background suspend: carrier drops
  useConnectionStore.getState().setConnection({ connected: false });
  assert.equal(useConnectionStore.getState().connected, false);

  // While disconnected, file access fails gracefully without throwing
  const offlineFiles = await useFileBusStore.getState().getFiles("/app");
  assert.deepEqual(offlineFiles, { success: false, error: "Not connected" });

  // Notifications and badge remain intact across drop (no screen wipe)
  assert.equal(useNotificationStore.getState().notifications["session-1"]?.type, "done");

  // 5. App resumes: carrier re-establishes (e.g. upgraded to RTC or restored WS)
  const reconnectBusEmits = [];
  const reconnectBus = {
    emit: (event, payload, cb) => {
      reconnectBusEmits.push({ event, payload });
      if (event === "getFiles") cb?.({ success: true, files: [{ name: "reconnected.js", path: "/app/reconnected.js" }] });
    }
  };
  useConnectionStore.getState().setConnection({
    bus: reconnectBus,
    busRef: { current: reconnectBus },
    connected: true,
    carrier: "rtc"
  });
  assert.equal(useConnectionStore.getState().connected, true);
  assert.equal(useConnectionStore.getState().carrier, "rtc");

  // Files work immediately on new bus
  const newFiles = await useFileBusStore.getState().getFiles("/app");
  assert.equal(newFiles.success, true);
  assert.equal(newFiles.files[0].name, "reconnected.js");

  // 6. User types in session 1 -> notification is cleared
  useNotificationStore.getState().clearNotification("session-1");
  assert.equal(useNotificationStore.getState().notifications["session-1"], undefined);
  assert.equal(useNotificationStore.getState().sessionStatus["session-1"]?.state, "idle");
  assert.equal(useNotificationStore.getState().sessionStatus["session-1"]?.tool, "bash"); // icon stays
  assert.equal(reconnectBusEmits.some((e) => e.event === "clearStatus" && e.payload === "session-1"), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
