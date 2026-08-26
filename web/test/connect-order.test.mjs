// Verifies the connect order: RTC and the WS tunnel are brought up in PARALLEL,
// with RTC preferred for data and WS kept warm as an instant-switch standby (a
// carrier swap then costs 0ms instead of a spawn-on-failure stall). Signaling is
// DO-only; the tunnel carries data.
//
// RTC's start is CONDITIONAL: an offer created before the DO relay is up only
// reaches the outbound buffer (~8.5s of relay startup was measured), so connect()
// defers it to onSignalingReady, with a bounded backstop. The two cases below
// pin both halves of that.
//
// Mocks adapter instantiation + signaling so no network happens; spies on the
// methods that would start each transport.
//
// Run: node --import ./test/loader-alias.mjs ./test/connect-order.test.mjs

// Minimal browser globals — PM constructor touches document/window.
globalThis.document = { addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
// hostname too — termLog reads it at import time to decide whether to buffer.
globalThis.location = { protocol: "https:", host: "dev.9remote.cc", hostname: "dev.9remote.cc" };
globalThis.localStorage = { getItem: () => null, setItem() {} };

let pass = 0, fail = 0;
const assert = (cond, label) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  cond ? pass++ : fail++;
};

const { ProtocolManager } = await import("../shared/transport/ProtocolManager.js");

// Build a PM with WebRTC enabled (remoteDesktop profile → enabled: ["ws","rtc"]).
const pm = new ProtocolManager({
  tunnelUrl: "wss://tunnel.example", localIp: null,
  apiKey: "k", tempKey: null, deviceId: "dev1",
  namespace: "", socketOptions: {}
}, { enableWebRTC: true });

// Neutralize network-touching methods, record call order.
const calls = [];
pm._instantiate = (id) => { calls.push(`instantiate:${id}`); };
pm._adapters.get = () => ({ connect: () => calls.push("ws.connect") }); // ws adapter stub
// Per-id stub. RTC is absent until _startSecondaryAdapters builds it — the
// deferred-start path keys off exactly that, so handing back a peer here would
// make onSignalingReady think RTC is already negotiating.
let rtcBuilt = false;
pm._adapters.get = function (id) {
  if (id === "ws") return { connect: () => calls.push("ws.connect") };
  if (id === "rtc" && rtcBuilt) return { connect: () => calls.push("rtc.connect"), disconnect() {} };
  return undefined;
};
pm._initSignalingClient = () => calls.push("initSignaling");
pm._startSecondaryAdapters = () => { rtcBuilt = true; calls.push("startSecondary"); };

// _refreshTunnelUrl would hit the Worker; stub it so ws.connect is reached.
pm._refreshTunnelUrl = async () => {};

pm.connect();
// _startWsFallback awaits the tunnel-url refresh before connecting — let the
// microtask queue drain, else we read `calls` a turn too early.
await new Promise((r) => setTimeout(r, 0));

// 1. The relay is not ready in this harness, so RTC is deferred rather than
//    offering into a buffer nobody drains. onSignalingReady starts it.
assert(!calls.includes("startSecondary"), "RTC deferred while the relay is down");

// 2. WS comes up in parallel — it is the warm standby, not a fallback spawned
//    after RTC fails.
assert(calls.includes("ws.connect"), "WS started in parallel with RTC");

// 3. DO signaling client initialized
assert(calls.includes("initSignaling"), "DO signaling client initialized");

// 4. RTC is gated on the RELAY, never on the tunnel. Report the relay ready and
//    it starts — with no WS open event anywhere in the run.
pm._canSignal = () => true;
pm._onSignalingReady();
const secIdx = calls.indexOf("startSecondary");
const wsOpenIdx = calls.indexOf("ws.open"); // never recorded → -1
assert(secIdx > -1 && wsOpenIdx === -1, "RTC starts on relay-ready, with no WS open event");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
