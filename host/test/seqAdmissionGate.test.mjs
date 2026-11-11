// Admission gate on the PM's manual dispatch path — the security-critical rule
// that onAny fires BEFORE socket.use, so RTC- and __env-carried events on a
// REAL socket must be gated inside the PM (a pending device must not reach
// feature handlers no matter which carrier or wrapper it uses).
// Run: node host/test/seqAdmissionGate.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ProtocolManager } from "../transport/ProtocolManager.js";
import { CONNECTION_STATE } from "../lib/connectionConstants.js";

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push(Promise.resolve().then(async () => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}));

/** Minimal real-socket stand-in: no dispatchAny (PM must invoke manually). */
function realSocket() {
  const s = new EventEmitter();
  s.id = "sock1";
  s.connected = true;
  s.data = {};
  s.handshake = { auth: {}, headers: {}, address: "t" };
  s.broadcast = { emit: () => true };
  s.onAny = () => {};
  return s;
}

function makePm(socket, connState) {
  socket.data.conn = connState
    ? { allows: (ev) => connState === "active" || ev === "device:tailProof", active: connState === "active" }
    : null;
  const pm = new ProtocolManager(socket, { enableWebRTC: false, maxControlBuffer: 500 });
  const hits = [];
  socket.on("getSessions", () => hits.push("getSessions"));
  socket.on("device:tailProof", () => hits.push("tailProof"));
  return { pm, hits };
}

test("RTC event from a PENDING device never reaches feature handlers", () => {
  const socket = realSocket();
  const { pm, hits } = makePm(socket, "authenticating");
  pm._dispatch("getSessions", { event: "getSessions", args: [{}], sq: null, ep: null }, "rtc");
  assert.deepEqual(hits, [], "manual invocation must apply the socket.use rule itself");
});

test("RTC event from an APPROVED device reaches handlers", () => {
  const socket = realSocket();
  const { pm, hits } = makePm(socket, "active");
  pm._dispatch("getSessions", { event: "getSessions", args: [{}], sq: null, ep: null }, "rtc");
  assert.deepEqual(hits, ["getSessions"]);
});

test("WS __env wrapper from a PENDING device is gated the same as RTC", () => {
  const socket = realSocket();
  const { pm, hits } = makePm(socket, "authenticating");
  const wire = { event: "getSessions", args: [{}], ackId: null, sq: null, ep: null };
  pm._dispatch("__env", wire, "ws", [wire]);
  assert.deepEqual(hits, [], "__env must not become a gate bypass");
});

test("auth events still pass while pending — the handshake must not deadlock", () => {
  const socket = realSocket();
  const { pm, hits } = makePm(socket, "authenticating");
  pm._dispatch("device:tailProof", { event: "device:tailProof", args: [{}] }, "rtc");
  assert.deepEqual(hits, ["tailProof"]);
});

test("no conn yet (pre-setup): only auth events pass, mirroring socket.use", () => {
  const socket = realSocket();
  const { pm, hits } = makePm(socket, null);
  pm._dispatch("getSessions", { event: "getSessions", args: [{}] }, "rtc");
  pm._dispatch("device:tailProof", { event: "device:tailProof", args: [{}] }, "rtc");
  assert.deepEqual(hits, ["tailProof"]);
});

test("plain WS events on a real socket are NOT manually invoked (socket.io dispatches them)", () => {
  const socket = realSocket();
  const { pm, hits } = makePm(socket, "active");
  pm._dispatch("getSessions", { v: 1 }, "ws", [{ v: 1 }]);
  assert.deepEqual(hits, [], "socket.io's own (gated) dispatch owns plain WS — manual invoke would double-fire");
});

test("HostBus (virtual) sessions keep their own listener-side gate", async () => {
  const { HostBus } = await import("../transport/HostBus.js");
  const bus = new HostBus({ deviceId: "d1", peerId: "d1:t", apiKey: "k" });
  bus.on("getSessions", () => {});
  bus.data.conn = { allows: () => false }; // pending
  assert.equal(bus.listeners("getSessions").length, 0, "HostBus.filters by conn.allows");
  bus.data.conn = { allows: () => true };
  assert.equal(bus.listeners("getSessions").length, 1);
});


// A gated REQUEST used to vanish: the sender waited out its own timeout with no
// way to tell "lost" from "refused". The gate now answers it, and tells a peer
// whose connection closed (once per episode) to re-admit.
test("a gated request is answered not-admitted, never left to time out", () => {
  const socket = realSocket();
  const { pm } = makePm(socket, "authenticating");
  const sent = [];
  pm._sendAck = (ackId, resp) => sent.push([ackId, resp]);
  pm._dispatch("getSessions", { event: "getSessions", args: [{}], ackId: "c_9", sq: null, ep: null }, "rtc");
  assert.deepEqual(sent, [["c_9", [{ ok: false, success: false, error: "not-admitted" }]]]);
});

test("a closed connection tells the peer to re-admit — once per burst", () => {
  const socket = realSocket();
  const { pm } = makePm(socket, "closed");
  socket.data.conn.closed = true;
  const notices = [];
  pm._sendAck = () => {};
  pm._sendControl = (ev) => notices.push(ev);
  for (let i = 0; i < 4; i++) pm._dispatch("getSessions", { event: "getSessions", args: [{}], ackId: `c_${i}` }, "rtc");
  assert.deepEqual(notices, ["conn:notAdmitted"]);
});

await Promise.all(tests);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
