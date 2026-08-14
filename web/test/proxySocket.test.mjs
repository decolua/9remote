// Characterization tests for the PM proxy socket extracted from ProtocolManager.
// The proxy must survive raw-socket churn: listeners registered before/without a
// raw socket still fire on RTC dispatch, and re-bind to each fresh socket.
// Run: node --import ./test/loader-alias.mjs web/test/proxySocket.test.mjs
import assert from "node:assert/strict";
import { createProxySocket, rebindProxyListeners, fireProxyEvent } from "../shared/transport/lib/proxySocket.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

function fakeRawSocket(id = "sock1") {
  const bound = new Map();
  return {
    id,
    bound,
    disconnected: false,
    on(ev, h) { if (!bound.has(ev)) bound.set(ev, new Set()); bound.get(ev).add(h); },
    off(ev, h) { bound.get(ev)?.delete(h); },
    disconnect() { this.disconnected = true; },
    fire(ev, ...args) { for (const h of bound.get(ev) || []) h(...args); }
  };
}

function makePm({ raw = null, ready = true } = {}) {
  return {
    _rawSocket: raw,
    sent: [],
    _anyAdapterReady: () => ready,
    _sendControl(event, args) { this.sent.push([event, args]); }
  };
}

test("emit routes through PM._sendControl (never the raw socket)", () => {
  const pm = makePm({ raw: fakeRawSocket() });
  const proxy = createProxySocket(pm);
  proxy.emit("resize", { cols: 80 }, 42);
  assert.deepEqual(pm.sent, [["resize", [{ cols: 80 }, 42]]]);
});

test("connected/id follow PM state, not a cached socket", () => {
  const raw = fakeRawSocket("abc");
  const pm = makePm({ raw, ready: false });
  const proxy = createProxySocket(pm);
  assert.equal(proxy.connected, false);
  assert.equal(proxy.id, "abc");
  pm._anyAdapterReady = () => true;
  assert.equal(proxy.connected, true);
  pm._rawSocket = null;
  assert.equal(proxy.id, null, "no raw socket → null id (RTC-only session)");
});

test("on/off track listeners and delegate to the raw socket", () => {
  const raw = fakeRawSocket();
  const pm = makePm({ raw });
  const proxy = createProxySocket(pm);
  const h = () => {};
  proxy.on("output", h);
  assert.deepEqual(proxy.listeners("output"), [h]);
  assert.equal(raw.bound.get("output").has(h), true);
  proxy.off("output", h);
  assert.deepEqual(proxy.listeners("output"), []);
  assert.equal(raw.bound.get("output").has(h), false);
});

test("listeners registered with NO raw socket still fire via fireProxyEvent (RTC-first)", () => {
  const pm = makePm({ raw: null });
  const proxy = createProxySocket(pm);
  let fired = 0;
  proxy.on("connect", () => { fired++; });
  fireProxyEvent(proxy, "connect");
  assert.equal(fired, 1);
});

test("fireProxyEvent survives a throwing handler (one bad pane can't block rejoin)", () => {
  const pm = makePm();
  const proxy = createProxySocket(pm);
  let second = 0;
  proxy.on("connect", () => { throw new Error("boom"); });
  proxy.on("connect", () => { second++; });
  fireProxyEvent(proxy, "connect");
  assert.equal(second, 1);
});

test("once fires exactly once and unregisters from both sides", () => {
  const raw = fakeRawSocket();
  const pm = makePm({ raw });
  const proxy = createProxySocket(pm);
  let calls = 0;
  proxy.once("ready", () => { calls++; });
  assert.equal(proxy.listeners("ready").length, 1);
  raw.fire("ready");
  raw.fire("ready");
  assert.equal(calls, 1);
  assert.equal(proxy.listeners("ready").length, 0, "wrapper removed after firing");
});

test("once dispatched via fireProxyEvent also fires once (no raw socket)", () => {
  const pm = makePm({ raw: null });
  const proxy = createProxySocket(pm);
  let calls = 0;
  proxy.once("connect", () => { calls++; });
  fireProxyEvent(proxy, "connect");
  fireProxyEvent(proxy, "connect");
  assert.equal(calls, 1);
});

test("rebindProxyListeners re-attaches every tracked listener to a fresh socket", () => {
  const raw1 = fakeRawSocket("s1");
  const pm = makePm({ raw: raw1 });
  const proxy = createProxySocket(pm);
  let out = 0, err = 0;
  proxy.on("output", () => { out++; });
  proxy.on("error", () => { err++; });

  // Reconnect: brand new raw socket with nothing bound
  const raw2 = fakeRawSocket("s2");
  pm._rawSocket = raw2;
  assert.equal(raw2.bound.size, 0);
  rebindProxyListeners(raw2, proxy);
  raw2.fire("output");
  raw2.fire("error");
  assert.equal(out, 1);
  assert.equal(err, 1);
});

test("rebindProxyListeners is a no-op without a socket or proxy", () => {
  const proxy = createProxySocket(makePm());
  rebindProxyListeners(null, proxy);
  rebindProxyListeners(fakeRawSocket(), null);
  rebindProxyListeners(fakeRawSocket(), {});
});

test("disconnect delegates to the raw socket when present", () => {
  const raw = fakeRawSocket();
  const pm = makePm({ raw });
  const proxy = createProxySocket(pm);
  proxy.disconnect();
  assert.equal(raw.disconnected, true);
  pm._rawSocket = null;
  proxy.disconnect(); // must not throw
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
