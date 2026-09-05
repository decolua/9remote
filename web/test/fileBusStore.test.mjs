import assert from "node:assert/strict";
import { useConnectionStore } from "../shared/stores/connectionStore.js";
import { useFileBusStore } from "../shared/stores/fileBusStore.js";

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

await test("when disconnected, getFiles resolves with { success: false, error: 'Not connected' }", async () => {
  useConnectionStore.getState().reset();
  const res = await useFileBusStore.getState().getFiles("/any");
  assert.deepEqual(res, { success: false, error: "Not connected" });
});

await test("when connected, getFiles calls bus.emit('getFiles', ...) and normalizes paths", async () => {
  const calls = [];
  const fakeBus = {
    emit: (event, payload, cb) => {
      calls.push({ event, payload });
      if (event === "getFiles") {
        cb({ success: true, files: [{ name: "foo", path: "C:\\Users\\foo" }] });
      }
    }
  };

  useConnectionStore.getState().setConnection({
    bus: fakeBus,
    busRef: { current: fakeBus },
    connected: true
  });

  const res = await useFileBusStore.getState().getFiles("/test/dir", true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, "getFiles");
  assert.deepEqual(calls[0].payload, { dirPath: "/test/dir", showHidden: true });
  assert.equal(res.success, true);
  // Normalized Windows path to POSIX
  assert.equal(res.files[0].path, "C:/Users/foo");
});

await test("onFileChange subscribes and un-subscribes on current bus", () => {
  const events = [];
  const fakeBus = {
    on: (ev, fn) => events.push({ type: "on", ev, fn }),
    off: (ev, fn) => events.push({ type: "off", ev, fn })
  };

  useConnectionStore.getState().setConnection({
    bus: fakeBus,
    busRef: { current: fakeBus },
    connected: true
  });

  const handler = () => {};
  const unsub = useFileBusStore.getState().onFileChange(handler);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "on");
  assert.equal(events[0].ev, "fileChange");
  assert.equal(events[0].fn, handler);

  unsub();
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "off");
  assert.equal(events[1].ev, "fileChange");
  assert.equal(events[1].fn, handler);
});

await test("onFileChange still registers if busRef is set even before connected is true", () => {
  const events = [];
  const fakeBus = {
    on: (ev, fn) => events.push({ type: "on", ev, fn }),
    off: (ev, fn) => events.push({ type: "off", ev, fn })
  };

  useConnectionStore.getState().setConnection({
    bus: fakeBus,
    busRef: { current: fakeBus },
    connected: false
  });

  const handler = () => {};
  const unsub = useFileBusStore.getState().onFileChange(handler);
  assert.equal(events.length, 1);
  assert.equal(events[0].ev, "fileChange");
  unsub();
  assert.equal(events.length, 2);
});

await test("gitChangedCount queries bus properly", async () => {
  let calledWith = null;
  const fakeBus = {
    emit: (event, payload, cb) => {
      if (event === "gitChangedCount") {
        calledWith = payload;
        cb({ count: 5 });
      }
    }
  };

  useConnectionStore.getState().setConnection({
    bus: fakeBus,
    busRef: { current: fakeBus },
    connected: true
  });

  const res = await useFileBusStore.getState().gitChangedCount("/repo");
  assert.deepEqual(calledWith, { repoPath: "/repo" });
  assert.deepEqual(res, { count: 5 });
});

await test("transfer functions handle disconnected state gracefully", async () => {
  useConnectionStore.getState().reset();
  let uploadErr = null;
  await useFileBusStore.getState().uploadFiles("/target", [], {
    onError: (_f, err) => { uploadErr = err; }
  });
  assert.equal(uploadErr?.message, "Not connected");

  let downloadErr = null;
  await useFileBusStore.getState().downloadFile("/file", {
    onError: (err) => { downloadErr = err; }
  });
  assert.equal(downloadErr?.message, "Not connected");

  let streamErr = null;
  const { cancel } = useFileBusStore.getState().streamMedia("/media", {
    onError: (err) => { streamErr = err; }
  });
  assert.equal(typeof cancel, "function");
  assert.equal(streamErr?.message, "Not connected");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
