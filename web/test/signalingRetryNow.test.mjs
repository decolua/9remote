// Burst-collapsing tests for SignalingClient.retryNow().
//
// Every accepted retryNow() opens a WebSocket, and every WS upgrade runs the
// signaling DO's session gate — one D1 read. visibilitychange / resume /
// network-change all call it and all fire together on a mobile app switch, which
// is how "SELECT 1 FROM sessions" reached 1.42M/day (109x the /api/connect count).
//
// These exercise the REAL class against a fake clock and WebSocket, so the
// throttle cannot silently drift from what ships.
//
// Run: node --import ./test/loader-alias.mjs web/test/signalingRetryNow.test.mjs
import assert from "node:assert/strict";
import { ADAPTER_STATE } from "../shared/constants/transport.js";

// ── Fake timers + clock ────────────────────────────────────────────────────
let now = 1700000000000;
let timers = [];
let seq = 0;

const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

Date.now = () => now;
globalThis.setTimeout = (fn, delay = 0) => {
  const t = { id: ++seq, at: now + delay, fn, cancelled: false };
  timers.push(t);
  return t.id;
};
globalThis.clearTimeout = (id) => {
  const t = timers.find((x) => x.id === id);
  if (t) t.cancelled = true;
};

function advance(ms) {
  const end = now + ms;
  for (;;) {
    const due = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    now = due.at;
    due.cancelled = true;
    due.fn();
  }
  now = end;
}

// ── Fake WebSocket: records every construction (= one gate query) ──────────
let opens = 0;
class FakeWebSocket {
  constructor() {
    opens++;
    this.readyState = 0; // CONNECTING
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  close() { this.readyState = 3; }
  send() {}
  _emit(type) { for (const fn of this._listeners[type] || []) fn({}); }
}
globalThis.WebSocket = FakeWebSocket;

const { SignalingClient } = await import("../shared/transport/SignalingClient.js");

function makeClient() {
  opens = 0;
  timers = [];
  return new SignalingClient({
    url: "wss://example.test/signaling",
    role: "client",
    roomId: "sk-test",
    apiKey: "sk-test",
    from: "device:tab",
  });
}

const openSocket = (c) => { c._ws.readyState = 1; c._ws._emit("open"); };
const killSocket = (c) => { const ws = c._ws; ws.readyState = 3; ws._emit("close"); };

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ── Tests ──────────────────────────────────────────────────────────────────

test("burst of 3 in one tick opens a single socket", () => {
  const c = makeClient();
  c.retryNow(); c.retryNow(); c.retryNow();
  assert.equal(opens, 1);
});

test("a healthy open socket is never replaced", () => {
  const c = makeClient();
  c.connect();
  openSocket(c);
  const before = opens;
  for (let i = 0; i < 20; i++) c.retryNow();
  assert.equal(opens, before);
});

test("in-flight handshake is left alone", () => {
  const c = makeClient();
  c.connect();               // connecting, not yet open
  const before = opens;
  advance(3100);             // past the throttle, still inside the stall window
  c.retryNow();
  assert.equal(opens, before, "should not restart a fresh handshake");
});

test("a stalled handshake is replaced", () => {
  const c = makeClient();
  c.connect();
  advance(6000);             // beyond HANDSHAKE_STALL_MS
  c.retryNow();
  assert.equal(opens, 2);
});

test("a throttled call is deferred, never dropped", () => {
  const c = makeClient();
  c.retryNow();              // accepted
  killSocket(c);
  const before = opens;
  c.retryNow();              // throttled → must be deferred
  assert.equal(opens, before, "no immediate reopen");
  advance(6000);
  assert.equal(opens, before + 1, "deferred retry eventually ran");
});

test("real network change after a quiet period retries at once", () => {
  const c = makeClient();
  c.retryNow();
  killSocket(c);
  advance(10000);
  const before = opens;
  c.retryNow();
  assert.equal(opens, before + 1);
});

// The real mobile pattern: the relay is down/connecting and the user switches
// apps repeatedly. retryNow fires each time but the socket is not being killed
// by us — this is the traffic that produced the 109:1 gate ratio.
test("50 app switches over a live handshake add no upgrades", () => {
  const c = makeClient();
  c.connect();
  const afterConnect = opens;
  for (let i = 0; i < 50; i++) {
    advance(1200);
    c.retryNow();
  }
  // Only stall-window expiries may reopen; nowhere near one per switch.
  assert.ok(opens - afterConnect <= 12, `expected <=12 extra upgrades, got ${opens - afterConnect}`);
});

// When the socket genuinely dies each round, _onClose's own backoff drives the
// reconnects — retryNow throttling neither can nor should suppress those. Kept
// as a guard that the throttle has not broken real recovery.
test("50 genuine socket deaths still reconnect", () => {
  const c = makeClient();
  for (let i = 0; i < 50; i++) {
    advance(1200);
    if (c._ws) killSocket(c);
    c.retryNow();
  }
  assert.ok(opens > 0, "must still reconnect");
  assert.ok(opens <= 50, `never more than one per event, got ${opens}`);
});

test("500 events in 10s collapse to a handful", () => {
  const c = makeClient();
  for (let i = 0; i < 500; i++) {
    advance(20);
    if (c._ws) killSocket(c);
    c.retryNow();
  }
  advance(4000);
  assert.ok(opens <= 10, `expected <=10 upgrades, got ${opens}`);
});

test("disconnect() cancels a pending deferred retry", () => {
  const c = makeClient();
  c.retryNow();
  killSocket(c);
  c.retryNow();              // deferred
  c.disconnect();
  const before = opens;
  advance(10000);
  assert.equal(opens, before, "no socket opened after disconnect");
});

test("throttle does not stall recovery indefinitely", () => {
  const c = makeClient();
  c.connect();
  killSocket(c);
  // Nothing but retryNow drives recovery once pre-open failures cap out.
  for (let i = 0; i < 10; i++) { advance(500); c.retryNow(); }
  advance(6000);
  assert.ok(opens >= 2, `relay must reconnect, got ${opens} upgrades`);
});

test("retryNow stamps connecting time so the stall guard stays accurate", () => {
  const c = makeClient();
  c.retryNow();
  assert.equal(c._state, ADAPTER_STATE.connecting);
  assert.equal(c._connectingSince, now);
});

Date.now = realNow;
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
