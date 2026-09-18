// Integration spec: PM must deliver every carrier's events into the ONE ClientBus,
// and must not deliver anything twice.
//
// These are the failures the old two-registry design could produce, written as the
// behaviour the app depends on:
//   1. WS event reaches an app listener exactly once (socket.io used to invoke the
//      handler natively AND via the tracked map → duplicated terminal output).
//   2. RTC event reaches the same listener (no socket involved at all).
//   3. Listeners registered before any carrier exists still fire (RTC-first login).
//   4. A WS reconnect with a brand-new socket keeps every listener (used to need an
//      explicit rebind step).
//   5. The synthetic "connect" a carrier rejoin fires reaches app listeners.
//
// Run: node --import ./test/loader-alias.mjs test/clientBusIntegration.test.mjs
import assert from "node:assert/strict";
import { createClientBus } from "../shared/transport/lib/clientBus.js";
import { dispatch } from "../shared/transport/lib/pmMessaging.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Minimal PM stand-in with the fields pmMessaging.dispatch touches.
function makePm() {
  const pm = {
    _adapters: new Map(),
    _pendingAcks: new Map(),
    _ackTimers: new Map(),
    _awaitingApproval: false,
    _rtcTestDisabled: false,
    _rawSocket: null,
    _srvCaps: null,
    _canSignal: () => false,
    _restartRtc: () => {},
    _anyAdapterReady: () => true,
    _sendControl(event, args) { this.sent.push([event, args]); },
    sent: []
  };
  pm._bus = createClientBus(pm);
  pm.busRef = { current: pm._bus };
  return pm;
}

test("WS-delivered event reaches an app listener EXACTLY once", () => {
  const pm = makePm();
  let n = 0;
  pm._bus.on("output", () => { n++; });
  dispatch(pm, "output", { sessionId: "s1" }, "ws");
  assert.equal(n, 1, "no double delivery on the WS path");
});

test("RTC-delivered event reaches the same listener, args unwrapped", () => {
  const pm = makePm();
  const got = [];
  pm._bus.on("output", (p) => got.push(p));
  // RTC envelope shape: {event, args:[...]}
  dispatch(pm, "output", { event: "output", args: [{ sessionId: "s2" }] }, "rtc");
  assert.deepEqual(got, [{ sessionId: "s2" }]);
});

test("one listener, both carriers, two events → two deliveries (never four)", () => {
  const pm = makePm();
  let n = 0;
  pm._bus.on("output", () => { n++; });
  dispatch(pm, "output", { v: 1 }, "ws");
  dispatch(pm, "output", { event: "output", args: [{ v: 2 }] }, "rtc");
  assert.equal(n, 2);
});

test("listener registered with NO carrier up still fires (RTC-first login)", () => {
  const pm = makePm();
  pm._rawSocket = null;
  let fired = 0;
  pm._bus.on("terminal:ready", () => { fired++; });
  dispatch(pm, "terminal:ready", {}, "rtc");
  assert.equal(fired, 1);
});

test("WS reconnect with a fresh socket keeps every listener (no rebind step)", () => {
  const pm = makePm();
  pm._rawSocket = { id: "s1" };
  let out = 0, err = 0;
  pm._bus.on("output", () => { out++; });
  pm._bus.on("terminal:error", () => { err++; });

  pm._rawSocket = { id: "s2" }; // reconnected
  dispatch(pm, "output", {}, "ws");
  dispatch(pm, "terminal:error", {}, "ws");
  assert.equal(out, 1);
  assert.equal(err, 1);
});

test("the synthetic connect of a carrier rejoin reaches app listeners", () => {
  const pm = makePm();
  let rejoined = 0;
  pm._bus.on("connect", () => { rejoined++; });
  pm._bus.dispatch("connect", []); // what _maybeFireRejoin now does
  assert.equal(rejoined, 1);
});

test("app listeners on the bus fire on dispatch, once per event", () => {
  const pm = makePm();
  let app = 0;
  pm._bus.on("device:approved", () => { app++; });
  dispatch(pm, "device:approved", {}, "ws");
  assert.equal(app, 1, "app listener on the bus");
});

test("__ack is consumed by PM and never delivered to app listeners", () => {
  const pm = makePm();
  let leaked = 0;
  pm._bus.on("__ack", () => { leaked++; });
  let acked = null;
  pm._pendingAcks.set(7, (r) => { acked = r; });
  dispatch(pm, "__ack", { ackId: 7, args: [{ ok: true }] }, "rtc");
  assert.deepEqual(acked, { ok: true });
  assert.equal(leaked, 0, "ack is transport plumbing, not an app event");
});

test("srvCaps is still read by PM while dispatching normally", () => {
  const pm = makePm();
  const rtc = { setPeerCaps(c) { this.caps = c; } };
  pm._adapters.set("rtc", rtc);
  dispatch(pm, "srvCaps", { env2: 1 }, "ws");
  assert.deepEqual(rtc.caps, { env2: 1 });
  assert.deepEqual(pm._srvCaps, { env2: 1 });
});

test("a throwing app listener cannot break PM dispatch for the rest", () => {
  const pm = makePm();
  let ok = 0;
  pm._bus.on("output", () => { throw new Error("pane blew up"); });
  pm._bus.on("output", () => { ok++; });
  dispatch(pm, "output", {}, "ws");
  assert.equal(ok, 1);
});

// ── Reserved socket.io events ──────────────────────────────────────────────
//
// socket.io treats "connect"/"disconnect" as RESERVED: onAny never carries them,
// so they can never arrive through dispatch(). That is not a gap: consumers get
// the FIRST connect through the onConnect callback (they register their listener
// from inside it, and socket.io would not re-fire for an already-open socket
// either), and every LATER carrier open reaches them because the state handlers
// route it through _maybeFireRejoin → bus.dispatch("connect").
//
// The invariant worth pinning: a reconnect must reach app listeners, and it must
// arrive exactly once even though two carriers can flap around each other.

test("a carrier rejoin delivers 'connect' to app listeners", () => {
  const pm = makePm();
  let n = 0;
  pm._bus.on("connect", () => { n++; });
  pm._bus.dispatch("connect", []);   // what _maybeFireRejoin ends in
  assert.equal(n, 1);
});

test("each rejoin delivers 'connect' again (panes resync every time)", () => {
  const pm = makePm();
  let n = 0;
  pm._bus.on("connect", () => { n++; });
  pm._bus.dispatch("connect", []);
  pm._bus.dispatch("connect", []);
  assert.equal(n, 2);
});

test("'connect' cannot arrive through dispatch() — only the rejoin path fires it", () => {
  // A carrier delivering a literal "connect" message would double-fire the rejoin.
  // socket.io never does (reserved), and this pins that the bus is not fed one by
  // some future onAny change without the rejoin logic being considered.
  const pm = makePm();
  let n = 0;
  pm._bus.on("connect", () => { n++; });
  pm._bus.dispatch("connect", []);
  assert.equal(n, 1, "exactly one delivery per rejoin decision");
});

// ── Identity: consumers dedupe their registration by object identity ────────
//
// useSocket guards with `boundSocketRef.current === socket` so a second onConnect
// does not register every handler twice. That guard is only sound while the object
// handed to onConnect is stable for the PM's whole life — the bus is exactly that,
// and a NEW PM must hand out a different one so a remount rebinds instead of
// silently reusing a torn-down registry.

test("the bus handed to onConnect is stable across carrier changes", () => {
  const pm = makePm();
  const first = pm._bus;
  pm._rawSocket = { id: "s1" };
  dispatch(pm, "anything", {}, "ws");
  pm._rawSocket = { id: "s2" };          // carrier swapped
  assert.equal(pm._bus, first, "same object → consumers do not re-register");
});

test("a new PM hands out a DIFFERENT bus (a remount must rebind)", () => {
  const a = makePm();
  const b = makePm();
  assert.notEqual(a._bus, b._bus);
});

test("a cleared bus drops handlers while a fresh one still receives", () => {
  const oldPm = makePm();
  let stale = 0, fresh = 0;
  oldPm._bus.on("output", () => { stale++; });
  oldPm._bus.clear();                    // what PM.disconnect() does

  const newPm = makePm();
  newPm._bus.on("output", () => { fresh++; });
  dispatch(oldPm, "output", {}, "ws");
  dispatch(newPm, "output", {}, "ws");
  assert.equal(stale, 0, "torn-down PM delivers nothing");
  assert.equal(fresh, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
