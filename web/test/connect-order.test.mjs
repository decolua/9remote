// Verifies the RTC-first connect order: PM.connect() must start RTC immediately
// (signaling via DO), not wait for the tunnel WS to open. This is the core of the
// "DO signaling primary, tunnel fallback" architecture.
//
// Mocks adapter instantiation + signaling so no network happens; spies on the
// methods that would start each transport.
//
// Run: node --import ./test/loader-alias.mjs ./test/connect-order.test.mjs

// Minimal browser globals — PM constructor touches document/window.
globalThis.document = { addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.location = { protocol: "https:", host: "dev.9remote.cc" };

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
pm._adapters.get = function (id) {                    // per-id stub
  if (id === "ws") return { connect: () => calls.push("ws.connect") };
  if (id === "rtc") return { connect: () => calls.push("rtc.connect"), disconnect() {} };
  return undefined;
};
pm._initSignalingClient = () => calls.push("initSignaling");
pm._startSecondaryAdapters = () => calls.push("startSecondary");

pm.connect();

// 1. RTC (secondary adapters) starts from connect(), not deferred to WS open
assert(calls.includes("startSecondary"), "RTC started from connect()");

// 2. WS connect also called (parallel, not blocking RTC)
// WS is now lazy (RTC-first): it must NOT connect during connect() — only on
// RTC failure / grace-expire via _startWsFallback.
assert(!calls.includes("ws.connect"), "WS NOT started during connect() (lazy, RTC-first)");

// 3. DO signaling client initialized
assert(calls.includes("initSignaling"), "DO signaling client initialized");

// 4. RTC must NOT depend on WS — startSecondary fires even though ws.connect
//    is just a recorded stub (no open event ever fires)
const secIdx = calls.indexOf("startSecondary");
const wsOpenIdx = calls.indexOf("ws.open"); // never recorded → -1
assert(secIdx > -1 && wsOpenIdx === -1, "RTC started without any WS open event");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
