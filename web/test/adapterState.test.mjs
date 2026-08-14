// Differential + behavioural tests for the adapter state-change handlers
// extracted from ProtocolManager._onAdapterStateChange.
//
// The state machine here decides when onConnect / onDisconnect / rejoin fire —
// a drift produces phantom "Connection Failed" modals or double-registered
// listeners, so it is verified by replaying every state sequence through BOTH
// the original inline algorithm (transcribed from git HEAD) and the extracted
// handlers, then comparing the full side-effect trace.
//
// Run: node --import ./test/loader-alias.mjs web/test/adapterState.test.mjs
import assert from "node:assert/strict";
import { ADAPTER_STATE } from "../shared/constants/transport.js";
import { handleWsStateChange, handleRtcStateChange } from "../shared/transport/lib/adapterStateHandlers.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ── Fake PM ───────────────────────────────────────────────────────────────────
// Records every observable effect. Both implementations drive the same shape,
// so any behavioural drift shows up as a trace mismatch.
function makePm({ wsReady = false, rtcReady = false } = {}) {
  const trace = [];
  const adapters = new Map();
  const mk = (id, ready) => ({
    ready,
    socket: id === "ws" ? { id: `sock-${id}` } : undefined,
    connectionMode: id === "ws" ? "tunnel" : undefined,
    typeDetail: id === "rtc" ? "dc-stun" : undefined,
    state: ready ? ADAPTER_STATE.open : ADAPTER_STATE.closed
  });
  adapters.set("ws", mk("ws", wsReady));
  adapters.set("rtc", mk("rtc", rtcReady));

  const pm = {
    trace,
    _adapters: adapters,
    _connected: false,
    _connectionMode: "tunnel",
    _rawSocket: null,
    _lastWsState: null,
    _onConnectFired: false,
    _proxySocket: { _proxyListeners: new Map() },
    _rtcRestartAttempts: 3,
    _probeAttempts: 2,
    _rtcGivenUp: true,
    _giveUpIp: "203.0.113.7",
    _rtcRestartTimer: 111,
    _rejoinDebounceTimer: 222,
    _wsFallbackTimer: 333,
    _pendingAcks: new Map([["c_1", (r) => trace.push(["ackReject", r])]]),
    _ackTimers: new Map([["c_1", 444]]),
    _wsCallbacks: {
      onConnect: (sock, mode) => trace.push(["onConnect", mode]),
      onDisconnect: (why) => trace.push(["onDisconnect", why]),
      onUrlUpdate: (u) => trace.push(["onUrlUpdate", JSON.stringify(u)])
    },
    _rtcCallbacks: {
      onUpgrade: (d) => trace.push(["onUpgrade", d]),
      onFallback: (t) => trace.push(["onFallback", t])
    },
    _anyAdapterReady() {
      for (const a of this._adapters.values()) if (a.ready) return true;
      return false;
    },
    _maybeFireRejoin(id, reason) { trace.push(["rejoin", id, reason]); },
    _startWsFallback() { trace.push(["startWsFallback"]); },
    _scheduleRtcRestart() { trace.push(["scheduleRtcRestart"]); }
  };
  return pm;
}

const snapshot = (pm) => JSON.stringify({
  trace: pm.trace,
  connected: pm._connected,
  mode: pm._connectionMode,
  rawSocket: pm._rawSocket?.id ?? null,
  lastWsState: pm._lastWsState,
  onConnectFired: pm._onConnectFired,
  attempts: pm._rtcRestartAttempts,
  probeAttempts: pm._probeAttempts,
  givenUp: pm._rtcGivenUp,
  giveUpIp: pm._giveUpIp,
  restartTimer: pm._rtcRestartTimer,
  rejoinTimer: pm._rejoinDebounceTimer,
  pendingAcks: pm._pendingAcks.size,
  ackTimers: pm._ackTimers.size
});

// ── Original inline algorithm, transcribed verbatim from git HEAD ─────────────
function origStateChange(pm, adapterId, state) {
  if (adapterId === "ws") {
    const ws = pm._adapters.get("ws");
    if (state === ADAPTER_STATE.open) {
      const isReconnect = pm._lastWsState === ADAPTER_STATE.degraded;
      pm._connected = true;
      pm._connectionMode = ws?.connectionMode || "tunnel";
      pm._rawSocket = ws?.socket || null;
      if (isReconnect) pm._maybeFireRejoin("ws", "ws reconnect while rtc ready");
      if (pm._lastWsState !== ADAPTER_STATE.open) {
        if (pm._onConnectFired) {
          pm._wsCallbacks.onUrlUpdate?.({});
        } else {
          pm._onConnectFired = true;
          pm._wsCallbacks.onConnect?.(pm._proxySocket, pm._connectionMode);
        }
      }
    } else if (pm._lastWsState === ADAPTER_STATE.open) {
      pm._rawSocket = null;
      if (!pm._anyAdapterReady()) {
        pm._onConnectFired = false;
        pm._wsCallbacks.onDisconnect?.(state);
      }
    }
    pm._lastWsState = state;
  }

  if (adapterId === "rtc" && state === ADAPTER_STATE.open) {
    const isRtcReconnect = pm._onConnectFired;
    pm._wsFallbackTimer = null; // clearTimeout
    pm._rtcCallbacks.onUpgrade?.(pm._adapters.get("rtc")?.typeDetail || "dc-stun");
    if (!pm._onConnectFired) {
      pm._onConnectFired = true;
      pm._connected = true;
      pm._connectionMode = "webrtc";
      pm._wsCallbacks.onConnect?.(pm._proxySocket, pm._connectionMode);
    }
    pm._rtcRestartAttempts = 0;
    pm._probeAttempts = 0;
    pm._rtcGivenUp = false;
    pm._giveUpIp = null;
    pm._rtcRestartTimer = null;
    pm._rejoinDebounceTimer = null;
    if (isRtcReconnect) pm._maybeFireRejoin("rtc", "rtc reconnect while ws ready");
  }
  if (adapterId === "rtc" && state === ADAPTER_STATE.closed) {
    pm._rtcCallbacks.onFallback?.("ws");
    pm._startWsFallback();
    pm._wsFallbackTimer = null;
    for (const cb of pm._pendingAcks.values()) { try { cb({ error: "rtc-closed" }); } catch {} }
    pm._pendingAcks.clear();
    pm._ackTimers.clear();
    pm._scheduleRtcRestart();
    if (!pm._anyAdapterReady()) {
      pm._onConnectFired = false;
      pm._wsCallbacks.onDisconnect?.("rtc-closed");
    }
  }

  pm._connected = pm._anyAdapterReady();
}

// New path: the extracted handlers, driven exactly as PM drives them.
function newStateChange(pm, adapterId, state) {
  if (adapterId === "ws") handleWsStateChange(pm, state);
  if (adapterId === "rtc") handleRtcStateChange(pm, state);
  pm._connected = pm._anyAdapterReady();
}

// ── Differential sweep ────────────────────────────────────────────────────────
const STATES = [ADAPTER_STATE.open, ADAPTER_STATE.closed, ADAPTER_STATE.degraded, ADAPTER_STATE.connecting];
const IDS = ["ws", "rtc"];

test("differential: every 3-step state sequence matches the original", () => {
  let checked = 0;
  for (const wsReady of [false, true]) for (const rtcReady of [false, true]) {
    for (const a of IDS) for (const sa of STATES) {
      for (const b of IDS) for (const sb of STATES) {
        for (const c of IDS) for (const sc of STATES) {
          const seq = [[a, sa], [b, sb], [c, sc]];
          const p1 = makePm({ wsReady, rtcReady });
          const p2 = makePm({ wsReady, rtcReady });
          for (const [id, st] of seq) origStateChange(p1, id, st);
          for (const [id, st] of seq) newStateChange(p2, id, st);
          checked++;
          if (snapshot(p1) !== snapshot(p2)) {
            assert.fail(`MISMATCH seq=${JSON.stringify(seq)} wsReady=${wsReady} rtcReady=${rtcReady}\n  orig=${snapshot(p1)}\n  new =${snapshot(p2)}`);
          }
        }
      }
    }
  }
  assert.ok(checked >= 1000, `expected a wide sweep, ran ${checked}`);
  console.log(`      (${checked} sequences compared)`);
});

// ── Behaviour pins (the rules a future edit must not break) ───────────────────
test("ws open fires onConnect once; a repeat open does not re-notify", () => {
  const pm = makePm({ wsReady: true });
  handleWsStateChange(pm, ADAPTER_STATE.open);
  assert.deepEqual(pm.trace, [["onConnect", "tunnel"]]);
  // still open → no re-fire at all (handlers would double-register on the proxy)
  handleWsStateChange(pm, ADAPTER_STATE.open);
  assert.equal(pm.trace.length, 1, "same-state open must not re-notify");
});

test("ws flap while RTC carries data: rejoin + url update, never a 2nd onConnect", () => {
  // RTC ready throughout → the session never drops, so onConnectFired stays true
  // and the tunnel coming back is only a mode/url update.
  const pm = makePm({ wsReady: true, rtcReady: true });
  handleWsStateChange(pm, ADAPTER_STATE.open);
  handleWsStateChange(pm, ADAPTER_STATE.degraded);
  pm.trace.length = 0;
  handleWsStateChange(pm, ADAPTER_STATE.open);
  assert.deepEqual(pm.trace, [
    ["rejoin", "ws", "ws reconnect while rtc ready"],
    ["onUrlUpdate", "{}"]
  ]);
});

test("full outage re-arms onConnect (next carrier up must re-notify the app)", () => {
  const pm = makePm({ wsReady: true });
  handleWsStateChange(pm, ADAPTER_STATE.open);
  pm._adapters.get("ws").ready = false; // nothing carrying data now
  handleWsStateChange(pm, ADAPTER_STATE.degraded);
  assert.equal(pm._onConnectFired, false, "outage → onConnect must fire again on recovery");
  pm._adapters.get("ws").ready = true;
  pm.trace.length = 0;
  handleWsStateChange(pm, ADAPTER_STATE.open);
  assert.ok(pm.trace.some((t) => t[0] === "onConnect"), "recovery after a real outage re-fires onConnect");
});

test("ws down with rtc alive suppresses onDisconnect", () => {
  const pm = makePm({ rtcReady: true });
  handleWsStateChange(pm, ADAPTER_STATE.open);
  pm.trace.length = 0;
  handleWsStateChange(pm, ADAPTER_STATE.closed);
  assert.deepEqual(pm.trace, [], "rtc still carrying data → no disconnect modal");
  assert.equal(pm._onConnectFired, true, "session is still up");
});

test("ws down with nothing else ready fires onDisconnect and re-arms onConnect", () => {
  const pm = makePm();
  handleWsStateChange(pm, ADAPTER_STATE.open);
  pm._adapters.get("ws").ready = false;
  pm.trace.length = 0;
  handleWsStateChange(pm, ADAPTER_STATE.closed);
  assert.deepEqual(pm.trace, [["onDisconnect", ADAPTER_STATE.closed]]);
  assert.equal(pm._onConnectFired, false, "next carrier up must fire onConnect again");
});

test("ws reconnect (degraded → open) fires the rejoin", () => {
  const pm = makePm();
  handleWsStateChange(pm, ADAPTER_STATE.open);
  handleWsStateChange(pm, ADAPTER_STATE.degraded);
  pm.trace.length = 0;
  handleWsStateChange(pm, ADAPTER_STATE.open);
  assert.deepEqual(pm.trace[0], ["rejoin", "ws", "ws reconnect while rtc ready"]);
});

test("rtc open resets the whole recovery budget", () => {
  const pm = makePm();
  handleRtcStateChange(pm, ADAPTER_STATE.open);
  assert.equal(pm._rtcRestartAttempts, 0);
  assert.equal(pm._probeAttempts, 0);
  assert.equal(pm._rtcGivenUp, false);
  assert.equal(pm._giveUpIp, null);
  assert.equal(pm._rtcRestartTimer, null);
  assert.equal(pm._rejoinDebounceTimer, null, "transparent switch → cancel pending rejoin");
});

test("rtc open before ws fires onConnect in webrtc mode", () => {
  const pm = makePm();
  handleRtcStateChange(pm, ADAPTER_STATE.open);
  assert.deepEqual(pm.trace, [["onUpgrade", "dc-stun"], ["onConnect", "webrtc"]]);
  assert.equal(pm._connectionMode, "webrtc");
});

test("rtc open while already connected fires the rejoin, not onConnect", () => {
  const pm = makePm();
  pm._onConnectFired = true;
  handleRtcStateChange(pm, ADAPTER_STATE.open);
  assert.equal(pm.trace.filter((t) => t[0] === "onConnect").length, 0);
  assert.deepEqual(pm.trace.at(-1), ["rejoin", "rtc", "rtc reconnect while ws ready"]);
});

test("rtc closed rejects pending acks so callers fail fast", () => {
  const pm = makePm({ wsReady: true });
  handleRtcStateChange(pm, ADAPTER_STATE.closed);
  assert.ok(pm.trace.some((t) => t[0] === "ackReject" && t[1].error === "rtc-closed"),
    "pending acks must be rejected, not left hanging");
  assert.equal(pm._pendingAcks.size, 0);
  assert.equal(pm._ackTimers.size, 0);
  assert.ok(pm.trace.some((t) => t[0] === "startWsFallback"));
  assert.ok(pm.trace.some((t) => t[0] === "scheduleRtcRestart"));
  assert.equal(pm.trace.filter((t) => t[0] === "onDisconnect").length, 0, "ws alive → no modal");
});

test("rtc closed with ws also down fires onDisconnect", () => {
  const pm = makePm();
  pm._onConnectFired = true;
  handleRtcStateChange(pm, ADAPTER_STATE.closed);
  assert.deepEqual(pm.trace.at(-1), ["onDisconnect", "rtc-closed"]);
  assert.equal(pm._onConnectFired, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
