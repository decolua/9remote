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
const makeRegistry = (row, servedBy = () => false, servedBus = () => null) => {
  const calls = { patch: [], opened: [] };
  const reg = new HostRegistry({
    hostOf: (head) => (head === HEAD ? row : undefined),
    patch: (head, p) => calls.patch.push({ head, p }),
    bindBus: () => {},
    ready: () => {},
    probeTargets: () => [],
    servedBy,
    servedBus
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

await test("a host another owner serves never gets a second wire", () => {
  // One wire per host: while the workspace connection serves this head, the
  // registry must neither open it nor queue an intent it can never fire.
  const { reg } = makeRegistry({ status: "full", full: "k" }, (h) => h === HEAD);
  let opened = false;
  reg.open = () => { opened = true; };
  reg.whenReady(HEAD, () => {});
  assert.equal(opened, false, "whenReady must not open a bus for a served host");
  assert.equal(reg.pending.size, 0, "and must not queue an intent it can never fire");
  // Even a direct open() call is refused.
  reg.open = HostRegistry.prototype.open;
  reg.open(HEAD, { status: "full", full: "k" });
  assert.equal(reg.has(HEAD), false);
});

await test("an intent for a served host rides the serving bus", () => {
  // One door for every host: the host another owner serves still takes its
  // intents — through that owner's bus, never a second wire.
  const owner = { emit: () => {} };
  const { reg } = makeRegistry({ status: "full", full: "k" }, (h) => h === HEAD, () => owner);
  const openReal = reg.open;
  reg.open = () => { throw new Error("must not open a second wire"); };
  let got = null;
  reg.whenReady(HEAD, (b) => { got = b; });
  assert.equal(got, owner);
  assert.equal(reg.pending.size, 0, "a served host's intent is served, not queued");
  reg.open = openReal;
});

await test("a served host with no live bus drops the intent quietly", () => {
  // Nothing to defer onto: the wire is not this registry's, and queueing would
  // promise a delivery it can never make.
  const { reg } = makeRegistry({ status: "connecting", full: "k" }, (h) => h === HEAD, () => null);
  let ran = false;
  reg.whenReady(HEAD, () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(reg.pending.size, 0);
});

await test("the same host is openable once the workspace looks elsewhere", () => {
  // Ownership is not a rank: it follows whoever the workspace is viewing, so a
  // host stops being served (and the registry may open it) the moment focus moves.
  const { reg } = makeRegistry({ status: "offline", full: "k" }, () => false);
  reg.open = () => {};
  reg.whenReady(HEAD, () => {});
  assert.equal(reg.pending.get(HEAD)?.length, 1, "an unserved host's intent must wait for its bus");
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
