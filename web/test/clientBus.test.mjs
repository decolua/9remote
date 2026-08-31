// TDD spec for ClientBus — the client-side mirror of the agent's AgentBus.
//
// Today the client keeps listeners in TWO places: a tracked map inside proxySocket
// AND the live socket.io socket. That duplication is what forces
// rebindProxyListeners (re-attach after every reconnect) and fireProxyEvent
// (invoke the map by hand when there is no raw socket). Each is a place the two
// copies can drift, and drift here means a pane that silently stops receiving.
//
// ClientBus removes the second copy: the bus IS the only listener registry, and PM
// dispatches into it regardless of which carrier delivered the message — exactly
// how the agent's AgentBus works. No rebinding, no manual firing.
//
// Run: node --import ./test/loader-alias.mjs test/clientBus.test.mjs
import assert from "node:assert/strict";
import { createClientBus } from "../shared/transport/lib/clientBus.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

function makePm({ ready = true, rawId = null } = {}) {
  return {
    sent: [],
    _rawSocket: rawId ? { id: rawId, disconnect() { this.disconnected = true; } } : null,
    _anyAdapterReady: () => ready,
    _sendControl(event, args) { this.sent.push([event, args]); }
  };
}

// ── Sending ────────────────────────────────────────────────────────────────

test("emit routes through PM._sendControl (never a carrier directly)", () => {
  const pm = makePm();
  const bus = createClientBus(pm);
  bus.emit("resize", { cols: 80 }, 42);
  assert.deepEqual(pm.sent, [["resize", [{ cols: 80 }, 42]]]);
});

test("emit works with no carrier up (PM buffers it) — never throws", () => {
  const pm = makePm({ ready: false });
  const bus = createClientBus(pm);
  bus.emit("getSessions", (r) => r);
  assert.equal(pm.sent.length, 1);
});

// ── Delivery: one registry, any carrier ────────────────────────────────────

test("a listener fires for a WS-delivered event", () => {
  const bus = createClientBus(makePm());
  const seen = [];
  bus.on("output", (p) => seen.push(p));
  bus.dispatch("output", [{ sessionId: "s1" }]);
  assert.deepEqual(seen, [{ sessionId: "s1" }]);
});

test("the SAME listener fires for an RTC-delivered event (no re-registration)", () => {
  const bus = createClientBus(makePm());
  let n = 0;
  bus.on("output", () => { n++; });
  bus.dispatch("output", [{ v: 1 }]);   // as if from WS
  bus.dispatch("output", [{ v: 2 }]);   // as if from RTC
  assert.equal(n, 2, "carrier is irrelevant to the registry");
});

test("multi-arg dispatch passes every argument through", () => {
  const bus = createClientBus(makePm());
  let got = null;
  bus.on("device:info", (a, b, c) => { got = [a, b, c]; });
  bus.dispatch("device:info", ["x", 2, { k: 1 }]);
  assert.deepEqual(got, ["x", 2, { k: 1 }]);
});

test("dispatch with no listener is a no-op (no throw)", () => {
  const bus = createClientBus(makePm());
  bus.dispatch("nobody-listens", [1]);
});

// ── The bug class this design removes ──────────────────────────────────────

test("RED: listeners survive a carrier swap with NO rebinding step", () => {
  // The old proxy needed rebindProxyListeners(newSocket, proxy) here. Forgetting
  // it (or a swap the PM did not notice) left the pane deaf. There is nothing to
  // forget now: the registry never lived on the socket.
  const pm = makePm({ rawId: "s1" });
  const bus = createClientBus(pm);
  let n = 0;
  bus.on("output", () => { n++; });

  pm._rawSocket = { id: "s2" };   // WS reconnected with a brand-new socket
  bus.dispatch("output", [{}]);
  assert.equal(n, 1, "listener must still fire after the socket was replaced");
});

test("RED: a listener registered while NO socket exists still fires (RTC-first login)", () => {
  const pm = makePm({ rawId: null });
  const bus = createClientBus(pm);
  let fired = 0;
  bus.on("connect", () => { fired++; });
  bus.dispatch("connect", []);
  assert.equal(fired, 1);
});

test("RED: no double-fire when a socket is present (one registry, one delivery)", () => {
  // The old design bound the handler to socket.io AND tracked it in a map; a
  // dispatch path that forgot the source check fired both copies, so panes
  // rendered duplicated output.
  const pm = makePm({ rawId: "s1" });
  const bus = createClientBus(pm);
  let n = 0;
  bus.on("output", () => { n++; });
  bus.dispatch("output", [{}]);
  assert.equal(n, 1, "exactly one delivery per dispatch");
});

test("RED: a throwing listener cannot block the others (one bad pane, N panes)", () => {
  const bus = createClientBus(makePm());
  const order = [];
  bus.on("connect", () => { order.push("a"); throw new Error("boom"); });
  bus.on("connect", () => { order.push("b"); });
  bus.dispatch("connect", []);
  assert.deepEqual(order, ["a", "b"]);
});

test("RED: off() during dispatch does not skip the next listener", () => {
  // Panes unmount from inside handlers (a rejoin tears one down). Iterating the
  // live Set while it mutates must not drop a sibling.
  const bus = createClientBus(makePm());
  const seen = [];
  const b = () => seen.push("b");
  bus.on("connect", () => { seen.push("a"); bus.off("connect", b); });
  bus.on("connect", b);
  bus.on("connect", () => seen.push("c"));
  bus.dispatch("connect", []);
  assert.deepEqual(seen, ["a", "c"], "removed mid-dispatch: skipped, but 'c' still runs");
});

test("RED: on() during dispatch does not fire the new listener in the same pass", () => {
  const bus = createClientBus(makePm());
  let late = 0;
  bus.on("connect", () => { bus.on("connect", () => { late++; }); });
  bus.dispatch("connect", []);
  assert.equal(late, 0, "added mid-dispatch waits for the next event");
  bus.dispatch("connect", []);
  assert.equal(late, 1);
});

// ── Registry hygiene ───────────────────────────────────────────────────────

test("off removes only the given handler", () => {
  const bus = createClientBus(makePm());
  let a = 0, b = 0;
  const ha = () => { a++; };
  const hb = () => { b++; };
  bus.on("e", ha); bus.on("e", hb);
  bus.off("e", ha);
  bus.dispatch("e", []);
  assert.equal(a, 0); assert.equal(b, 1);
});

test("off with an unknown event or handler is a no-op", () => {
  const bus = createClientBus(makePm());
  bus.off("never", () => {});
  bus.on("e", () => {});
  bus.off("e", () => {});
  assert.equal(bus.listeners("e").length, 1);
});

test("the same handler registered twice fires twice, and off removes one", () => {
  // socket.io semantics: duplicate registration is not deduped. A pane that
  // mounts twice must not silently collapse into one delivery.
  const bus = createClientBus(makePm());
  let n = 0;
  const h = () => { n++; };
  bus.on("e", h); bus.on("e", h);
  bus.dispatch("e", []);
  assert.equal(n, 2);
  bus.off("e", h);
  bus.dispatch("e", []);
  assert.equal(n, 3, "one copy remains");
});

test("listeners(event) reflects the registry", () => {
  const bus = createClientBus(makePm());
  const h = () => {};
  assert.deepEqual(bus.listeners("e"), []);
  bus.on("e", h);
  assert.deepEqual(bus.listeners("e"), [h]);
});

// ── once ───────────────────────────────────────────────────────────────────

test("once fires exactly once and leaves the registry clean", () => {
  const bus = createClientBus(makePm());
  let n = 0;
  bus.once("ready", () => { n++; });
  assert.equal(bus.listeners("ready").length, 1);
  bus.dispatch("ready", []);
  bus.dispatch("ready", []);
  assert.equal(n, 1);
  assert.equal(bus.listeners("ready").length, 0);
});

test("once receives its arguments", () => {
  const bus = createClientBus(makePm());
  let got = null;
  bus.once("ready", (a, b) => { got = [a, b]; });
  bus.dispatch("ready", [1, "x"]);
  assert.deepEqual(got, [1, "x"]);
});

test("once can be cancelled with off before it fires", () => {
  const bus = createClientBus(makePm());
  let n = 0;
  const h = () => { n++; };
  bus.once("ready", h);
  bus.off("ready", h);
  bus.dispatch("ready", []);
  assert.equal(n, 0, "off(handler) must find the wrapper registered for it");
});

test("a throwing once still unregisters (cannot wedge the registry)", () => {
  const bus = createClientBus(makePm());
  bus.once("ready", () => { throw new Error("boom"); });
  bus.dispatch("ready", []);
  assert.equal(bus.listeners("ready").length, 0);
});

// ── Socket-shaped surface the app already depends on ───────────────────────

test("connected follows PM adapter state, not a cached socket", () => {
  const pm = makePm({ ready: false });
  const bus = createClientBus(pm);
  assert.equal(bus.connected, false);
  pm._anyAdapterReady = () => true;
  assert.equal(bus.connected, true);
});

test("id is the raw socket id when on WS, null on an RTC-only session", () => {
  const pm = makePm({ rawId: "abc" });
  const bus = createClientBus(pm);
  assert.equal(bus.id, "abc");
  pm._rawSocket = null;
  assert.equal(bus.id, null);
});

test("disconnect delegates to the raw socket and is safe without one", () => {
  const pm = makePm({ rawId: "s1" });
  const bus = createClientBus(pm);
  bus.disconnect();
  assert.equal(pm._rawSocket.disconnected, true);
  pm._rawSocket = null;
  bus.disconnect(); // must not throw
});

// ── Teardown ───────────────────────────────────────────────────────────────

test("RED: clear() empties the registry (PM teardown must not leak listeners)", () => {
  // Listeners used to live on the socket.io socket and died with it. They live
  // here now, so a PM that is torn down (logout, unmount, remount) has to drop
  // them — otherwise a stale pane keeps a handler, and its closure, alive.
  const bus = createClientBus(makePm());
  let n = 0;
  bus.on("output", () => { n++; });
  bus.once("ready", () => { n++; });
  bus.clear();
  assert.deepEqual(bus.listeners("output"), []);
  assert.deepEqual(bus.listeners("ready"), []);
  bus.dispatch("output", []);
  bus.dispatch("ready", []);
  assert.equal(n, 0, "nothing fires after clear");
});

// PM.disconnect() is terminal in this app: useBaseSocket always constructs a new
// ProtocolManager and nulls the ref, so clear() dropping the PM's OWN device-auth
// listeners along with the app's is correct — that PM will never dispatch again.
// Reusability is still pinned below so the bus stays a plain, honest registry.
test("RED: the bus is reusable after clear (a remount registers again)", () => {
  const bus = createClientBus(makePm());
  bus.on("output", () => {});
  bus.clear();
  let n = 0;
  bus.on("output", () => { n++; });
  bus.dispatch("output", []);
  assert.equal(n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
