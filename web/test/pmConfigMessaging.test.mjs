// Characterization tests for the config mapping and data-path helpers extracted
// from ProtocolManager. Both are load-bearing: a wrong profile silently disables
// RTC, and a wrong control route corrupts the SCTP channel into a zombie.
// Run: node --import ./test/loader-alias.mjs web/test/pmConfigMessaging.test.mjs
import assert from "node:assert/strict";
import { TRANSPORT_PROFILES, CHANNELS, CONTROL_RTC_MAX_BYTES, ADAPTER_STATE } from "../shared/constants/transport.js";
import { buildConfig, initialState } from "../shared/transport/lib/pmConfig.js";
import { sendControl, flushBuffer, dispatch, onBinary, scheduleAckTimeout } from "../shared/transport/lib/pmMessaging.js";

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push(Promise.resolve().then(async () => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pmConfig ──────────────────────────────────────────────────────────────────
const WS_CFG = { tunnelUrl: "https://t", localIp: "10.0.0.2", apiKey: "k", tempKey: "tk", deviceId: "dev1", namespace: "/ns" };

test("config: no rtcConfig → ws-only profile", () => {
  const { profile } = buildConfig(WS_CFG, null);
  assert.deepEqual(profile.enabled, ["ws"]);
});

test("config: enableWebRTC picks remoteDesktop and keeps its adapter list", () => {
  const { profile } = buildConfig(WS_CFG, { enableWebRTC: true });
  assert.deepEqual(profile.enabled, TRANSPORT_PROFILES.remoteDesktop.enabled);
  assert.notEqual(profile, TRANSPORT_PROFILES.remoteDesktop, "must be a copy, not the shared constant");
});

test("config: enableTurn merges into rtc options without mutating the constant", () => {
  const before = JSON.stringify(TRANSPORT_PROFILES.remoteDesktop);
  const { profile } = buildConfig(WS_CFG, { enableWebRTC: true, enableTurn: true });
  assert.equal(profile.rtc.enableTurn, true);
  assert.equal(JSON.stringify(TRANSPORT_PROFILES.remoteDesktop), before, "shared profile must stay untouched");
});

test("config: auth carries every field the adapters need", () => {
  const { auth } = buildConfig(WS_CFG, null);
  assert.deepEqual(auth, { ...WS_CFG, socketOptions: undefined });
});

test("config: peerId is unique per instance and injected into socket auth", () => {
  const opts = { auth: { token: "t" } };
  const a = buildConfig({ ...WS_CFG, socketOptions: opts }, null);
  assert.match(a.peerId, /^dev1:[a-z0-9]+$/);
  assert.equal(opts.auth.peerId, a.peerId, "agent matches a tunnel connection by peerId");
  const b = buildConfig({ ...WS_CFG }, null);
  assert.notEqual(a.peerId, b.peerId, "two tabs must get independent RTC sessions");
});

test("config: callbacks are mapped, rtc callbacks default to empty", () => {
  const cbs = { onConnect: () => {}, onDisconnect: () => {}, onRetryStatus: () => {}, onUrlUpdate: () => {}, onApproval: () => {} };
  const { wsCallbacks, rtcCallbacks } = buildConfig({ ...WS_CFG, ...cbs }, null);
  assert.deepEqual(Object.keys(wsCallbacks).sort(), Object.keys(cbs).sort());
  assert.deepEqual(rtcCallbacks, {});
});

test("state: fresh instances never share mutable containers", () => {
  const a = initialState(), b = initialState();
  a._adapters.set("ws", 1);
  a._buffer.push("x");
  assert.equal(b._adapters.size, 0);
  assert.equal(b._buffer.length, 0);
  assert.equal(a._connected, false);
  assert.equal(a._type, "ws");
  assert.equal(a._connectionMode, "tunnel");
  assert.equal(a._onConnectFired, false);
});

// ── pmMessaging ───────────────────────────────────────────────────────────────
function adapter(id, { ready = true, sendOk = true } = {}) {
  const a = {
    ready,
    sent: [],
    state: ADAPTER_STATE.open,
    send(channel, payload) { a.sent.push([channel, payload]); return sendOk; }
  };
  a.constructor = { id, priority: { [CHANNELS.control]: id === "rtc" ? 10 : 1 } };
  return a;
}

function makePm({ pick = null, adapters = {} } = {}) {
  const trace = [];
  const pm = {
    trace,
    ...initialState(),
    _adapters: new Map(Object.entries(adapters)),
    // The app's listeners live on the bus, whichever carrier delivered the event.
    _sockListeners: new Map(),
    _bus: {
      dispatch(ev, args) { for (const h of pm._sockListeners.get(ev) || []) h(...args); }
    },
    _pickAdapter: () => pick,
    _scheduleAckTimeout(id) { trace.push(["ackTimeout", id]); },
    _scheduleRtcRestart() { trace.push(["scheduleRtcRestart"]); },
    _sendControl(ev, args) { sendControl(pm, ev, args); },
    _canSignal: () => true,
    _restartRtc() { trace.push(["restartRtc"]); }
  };
  return pm;
}

test("control: no adapter → buffered with its callback, flushed on the next adapter", () => {
  const pm = makePm();
  const cb = () => {};
  sendControl(pm, "resize", [{ cols: 80 }, cb]);
  assert.equal(pm._buffer.length, 1);
  assert.deepEqual(pm._buffer[0].args, [{ cols: 80 }]);
  assert.equal(pm._buffer[0].cb, cb, "the ack must survive the buffering");

  const ws = adapter("ws");
  pm._pickAdapter = () => ws;
  flushBuffer(pm);
  assert.equal(pm._buffer.length, 0);
  assert.deepEqual(ws.sent[0][1].args, [{ cols: 80 }]);
  assert.equal(ws.sent[0][1].cb, cb);
});

test("control: an oversize payload still rides RTC — slicing is the adapter's job", () => {
  const rtc = adapter("rtc");
  const ws = adapter("ws");
  const pm = makePm({ pick: rtc, adapters: { rtc, ws } });
  const big = "x".repeat(CONTROL_RTC_MAX_BYTES + 1);
  sendControl(pm, "paste", [big]);
  assert.equal(rtc.sent.length, 1, "the carrier is chosen from adapter state, not payload size");
  assert.equal(ws.sent.length, 0);
});

test("control: an RTC refusal is retried once, then dropped — never re-routed by hand", () => {
  const rtc = adapter("rtc", { sendOk: false });
  const ws = adapter("ws");
  const pm = makePm({ pick: rtc, adapters: { rtc, ws } });
  sendControl(pm, "input", ["hi"]);
  assert.equal(ws.sent.length, 0, "a refusal must not silently move the message to the other carrier");
  assert.equal(pm._buffer.length, 1, "undeliverable → buffered for the next ready window");
});

test("control: undersize payload stays on RTC and registers an ack timeout", () => {
  const rtc = adapter("rtc");
  const ws = adapter("ws");
  const pm = makePm({ pick: rtc, adapters: { rtc, ws } });
  sendControl(pm, "input", ["hi", () => {}]);
  assert.equal(rtc.sent.length, 1);
  assert.equal(ws.sent.length, 0);
  const { ackId } = rtc.sent[0][1];
  assert.match(ackId, /^c_\d+$/);
  assert.equal(pm._pendingAcks.size, 1);
  assert.deepEqual(pm.trace, [["ackTimeout", ackId]]);
});

test("control: an RTC refusal is buffered, not re-routed — the flush uses the live carrier", () => {
  const rtc = adapter("rtc", { sendOk: false });
  const ws = adapter("ws");
  const pm = makePm({ pick: rtc, adapters: { rtc, ws } });
  const cb = () => {};
  sendControl(pm, "input", ["hi", cb]);
  assert.equal(ws.sent.length, 0, "a refusal must not silently move one message to the other carrier");
  assert.equal(pm._buffer.length, 1);

  pm._pickAdapter = () => ws; // the adapter state caught up: RTC is closed
  flushBuffer(pm);
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0][1].cb, cb, "the ack survives the buffering");
});

test("flush: a message the carrier refuses goes back to the buffer, and the flush ends", () => {
  const rtc = adapter("rtc", { sendOk: false });
  const pm = makePm({ pick: rtc, adapters: { rtc } });
  pm._buffer.push({ event: "input", args: ["hi"], cb: null });
  flushBuffer(pm); // must terminate: a re-read loop would spin on the refused message
  assert.equal(pm._buffer.length, 1, "still undelivered — kept for the next ready window");
});

test("dispatch: __ack resolves the pending callback and clears its timer", () => {
  const pm = makePm();
  let got = null;
  pm._pendingAcks.set("c_1", (r) => { got = r; });
  pm._ackTimers.set("c_1", setTimeout(() => {}, 10_000));
  dispatch(pm, "__ack", { ackId: "c_1", args: [{ ok: true }] }, "rtc");
  assert.deepEqual(got, { ok: true });
  assert.equal(pm._pendingAcks.size, 0);
  assert.equal(pm._ackTimers.size, 0);
  // unknown ackId → no throw
  dispatch(pm, "__ack", { ackId: "nope" }, "rtc");
});

test("dispatch: RTC envelope spreads args; WS payload stays single-arg", () => {
  const pm = makePm();
  const seen = [];
  pm._sockListeners.set("output", [(...a) => seen.push(a)]);
  dispatch(pm, "output", { args: [1, 2, 3] }, "rtc");
  dispatch(pm, "output", { data: "x" }, "ws");
  assert.deepEqual(seen[0], [1, 2, 3]);
  assert.deepEqual(seen[1], [{ data: "x" }]);
});

test("dispatch: an app listener fires exactly once per event, on either carrier", () => {
  // The point is single delivery. It used to be enforced by skipping the forward
  // step for WS (socket.io had already invoked the handler itself); now nothing is
  // registered on the socket, so both carriers simply end at the bus — one copy,
  // one delivery, no source-dependent branch to get wrong.
  const pm = makePm();
  let app = 0;
  pm._sockListeners.set("output", [() => app++]);
  dispatch(pm, "output", { data: "x" }, "ws");
  assert.equal(app, 1, "WS delivery reaches the bus exactly once");
  dispatch(pm, "output", { args: ["y"] }, "rtc");
  assert.equal(app, 2, "RTC delivery reaches the same listener");
});

test("dispatch: device:approved clears the flag and renegotiates when rtc is dead", () => {
  const pm = makePm();
  pm._awaitingApproval = true;
  dispatch(pm, "device:approved", {}, "ws");
  assert.equal(pm._awaitingApproval, false);
  assert.deepEqual(pm.trace, [["restartRtc"]]);
  // rtc alive → no restart
  const pm2 = makePm({ adapters: { rtc: { ...adapter("rtc"), state: ADAPTER_STATE.open } } });
  pm2._awaitingApproval = true;
  dispatch(pm2, "device:approved", {}, "ws");
  assert.equal(pm2.trace.length, 0);
});

test("dispatch: rtc:enabled only restarts when the toggle was actually set", () => {
  const pm = makePm();
  dispatch(pm, "rtc:enabled", {}, "ws");
  assert.equal(pm.trace.length, 0);
  pm._rtcTestDisabled = true;
  dispatch(pm, "rtc:enabled", {}, "ws");
  assert.equal(pm._rtcTestDisabled, false);
  assert.deepEqual(pm.trace, [["restartRtc"]]);
});

test("binary: only the file channel reaches file-bin listeners", () => {
  const pm = makePm();
  const got = [];
  pm._sockListeners.set("file-bin", [(b) => got.push(b)]);
  onBinary(pm, { channel: "file", buffer: "B" });
  onBinary(pm, { channel: "tiles", buffer: "T" });
  onBinary(pm, null);
  assert.deepEqual(got, ["B"]);
});

test("ack timeout fires a restart when the reply never arrives", async () => {
  const pm = makePm();
  pm._ackTimeoutMs = 5;
  scheduleAckTimeout(pm, "c_9");
  assert.equal(pm._ackTimers.size, 1);
  await sleep(20);
  assert.equal(pm._ackTimers.size, 0);
  assert.deepEqual(pm.trace, [["scheduleRtcRestart"]]);
});

test("ack timeout ignores restart when rtc is actively receiving data", async () => {
  const pm = makePm({
    adapters: {
      rtc: { ready: true, lastInboundAt: Date.now() }
    }
  });
  pm._ackTimeoutMs = 10;
  scheduleAckTimeout(pm, "c_10", { event: "bg:get" });
  await sleep(20);
  assert.deepEqual(pm.trace, [], "must not restart rtc while inbound data is actively arriving");
});

test("dispatch: tunnel:updated sets tunnelUrl and retries ws", () => {
  const ws = adapter("ws");
  ws.ready = false;
  let retried = false;
  ws.retryNow = (why) => { retried = true; };
  const pm = makePm({ adapters: { ws } });
  pm._auth = { apiKey: "k", tunnelUrl: "" };
  let urlUpdate = null;
  pm._wsCallbacks = { onUrlUpdate: (u) => { urlUpdate = u; } };

  dispatch(pm, "tunnel:updated", { args: [{ status: "ready", tunnelUrl: "https://new-tunnel.test", localIp: "192.168.1.10:2208" }] }, "rtc");
  assert.equal(pm._auth.tunnelUrl, "https://new-tunnel.test");
  assert.equal(pm._auth.localIp, "192.168.1.10:2208");
  assert.equal(retried, true);
  assert.deepEqual(urlUpdate, { tunnelUrl: "https://new-tunnel.test", localIp: "192.168.1.10:2208" });
});

await Promise.all(tests);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
