// HostRegistry — pure connection-layer semantics: deferred intents, the
// online fast-path, drop/close bookkeeping. Transport construction is NOT
// exercised here (open() builds a real ProtocolManager); these tests cover the
// decision logic around a bus the registry already holds.

import assert from "node:assert/strict";
import { HostRegistry, savedConnectedHeads } from "../shared/transport/hostRegistry.js";

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

console.log("\n--- HostRegistry (pure) ---");

const HEAD = "reghead";
const makeRegistry = (row) => {
  const calls = { patch: [], opened: [] };
  const reg = new HostRegistry({
    hostOf: (head) => (head === HEAD ? row : undefined),
    patch: (head, p) => calls.patch.push({ head, p }),
    bindBus: () => {},
    ready: () => {},
    probeTargets: () => []
  });
  return { reg, calls };
};

await test("whenReady on an unknown host is a no-op (nothing queued, nothing opened)", () => {
  const { reg } = makeRegistry({ status: "offline", full: null });
  let ran = false;
  reg.whenReady("nope", () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(reg.pending.size, 0);
});

await test("whenReady with an online bus runs the intent immediately", () => {
  const { reg } = makeRegistry({ status: "online", full: "k" });
  const bus = { emit: () => {} };
  reg.buses.set(HEAD, { busRef: { current: bus } });
  let got = null;
  reg.whenReady(HEAD, (b) => { got = b; });
  assert.equal(got, bus);
  assert.equal(reg.pending.size, 0);
});

await test("whenReady with a host not yet online defers the intent", () => {
  // No bus in the registry → the intent must wait, not vanish.
  const { reg } = makeRegistry({ status: "offline", full: "k" });
  let ran = false;
  // Stub open so no real transport is built in the test
  reg.open = () => {};
  reg.whenReady(HEAD, () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(reg.pending.get(HEAD).length, 1);
});

await test("the ACTIVE host (status full) never gets a fleet bus", () => {
  const { reg } = makeRegistry({ status: "full", full: "k" });
  let opened = false;
  reg.open = () => { opened = true; };
  reg.whenReady(HEAD, () => {});
  assert.equal(opened, false, "whenReady must not open a bus for the active host");
  assert.equal(reg.pending.size, 0, "and must not queue an intent it can never fire");
  // Even a direct open() call is refused — the workspace connection owns it.
  reg.open = HostRegistry.prototype.open;
  reg.open(HEAD, { status: "full", full: "k" });
  assert.equal(reg.has(HEAD), false);
});

await test("drop removes the bus and any pending intents", () => {
  const { reg } = makeRegistry({ status: "online", full: "k" });
  reg.buses.set(HEAD, { disconnect: () => {}, busRef: { current: {} } });
  reg.pending.set(HEAD, [() => {}]);
  reg.drop(HEAD);
  assert.equal(reg.has(HEAD), false);
  assert.equal(reg.pending.has(HEAD), false);
});

await test("closeAll disarms and empties everything", () => {
  const { reg } = makeRegistry({ status: "online", full: "k" });
  reg.buses.set(HEAD, { disconnect: () => {}, busRef: { current: {} } });
  reg.pending.set(HEAD, [() => {}]);
  reg.closeAll();
  assert.equal(reg.buses.size, 0);
  assert.equal(reg.pending.size, 0);
  assert.equal(reg._probeTimer, null);
});

await test("savedConnectedHeads reads nothing outside the browser", () => {
  assert.deepEqual(savedConnectedHeads(), []);
});

console.log(fail === 0 ? `\n✅ ${pass} passed, ${fail} failed` : `\n❌ ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
