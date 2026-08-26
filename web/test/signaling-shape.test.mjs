// The wire shape between web and agent. Both sides own a private sigData() and
// the relay forwards {type, payload} verbatim, so the two copies MUST agree —
// a field one side drops is a field the other never receives (an unsigned answer
// reads as a relay swap and the peer is refused).
//
// This drives both real modules through their own send() and compares what comes
// out. The previous version restated sigData locally and passed happily while
// either copy drifted.
// Run: node --import ./test/loader-alias.mjs web/test/signaling-shape.test.mjs
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Capture what a SignalingClient puts on the wire, for either implementation.
function sentBy(SignalingClient, role, msg) {
  const sent = [];
  // The constructor only builds a URL; nothing opens until connect(), which this
  // deliberately skips. The global is stubbed anyway so a stray `new WebSocket`
  // in either implementation cannot reach the network.
  const prev = globalThis.WebSocket;
  globalThis.WebSocket = class { close() {} addEventListener() {} };
  try {
    // Never connect: _open() would arm timers and a real reconnect ladder. send()
    // gates on _ready and writes to _ws, which is all this needs.
    const sc = new SignalingClient({ url: "ws://x", role, roomId: "r", apiKey: "k", from: role });
    // The two implementations gate readiness differently — web reads
    // _ws.readyState, agent reads its own _ready flag. Satisfy both.
    sc._ready = true;
    sc._ws = { readyState: 1, send: (d) => sent.push(d) };
    const ok = sc.send(msg);
    if (!ok) throw new Error(`send() refused a ${msg.type}`);
  } finally {
    globalThis.WebSocket = prev;
  }
  return JSON.parse(sent.at(-1));
}

const web = (await import("../shared/transport/SignalingClient.js")).SignalingClient;
const agent = (await import("../../agent/transport/SignalingClient.js")).SignalingClient;

test("offer: both sides put the sdp in payload, addressed to the other role", () => {
  const w = sentBy(web, "client", { type: "offer", sdp: "SDP" });
  assert.deepEqual(w.payload, { sdp: "SDP" });
  assert.equal(w.to, "agent");
  assert.equal(w.type, "offer");
});

test("answer carries the host signature — dropping it makes the client refuse the peer", () => {
  const a = sentBy(agent, "agent", { type: "answer", sdp: "S", pub: "P", xpub: "X", sig: "G" });
  assert.deepEqual(a.payload, { sdp: "S", pub: "P", xpub: "X", sig: "G" });
  assert.equal(a.to, "client");
});

test("ice keeps candidate + mid, and survives a missing mid", () => {
  const w = sentBy(web, "client", { type: "ice", candidate: "C", mid: "0" });
  assert.deepEqual(w.payload, { candidate: "C", mid: "0" });
  const noMid = sentBy(web, "client", { type: "ice", candidate: "C" });
  assert.equal(noMid.payload.candidate, "C");
  assert.equal(noMid.payload.mid, undefined);
});

test("web and agent agree field-for-field on every message type", () => {
  // The relay is verbatim, so any asymmetry here is a message one side cannot read.
  for (const msg of [
    { type: "offer", sdp: "S" },
    { type: "answer", sdp: "S", pub: "P", xpub: "X", sig: "G" },
    { type: "ice", candidate: "C", mid: "1" },
    { type: "error", message: "nope" }
  ]) {
    assert.deepEqual(
      sentBy(web, "client", msg).payload,
      sentBy(agent, "agent", msg).payload,
      `${msg.type} shape differs between web and agent`
    );
  }
});

test("an inbound relay frame reconstructs to {type, ...payload}", () => {
  // What SignalingClient's message handler hands the PM.
  const frame = { from: "agent", type: "answer", payload: { sdp: "S", pub: "P" } };
  assert.deepEqual({ type: frame.type, from: frame.from, ...frame.payload },
    { type: "answer", from: "agent", sdp: "S", pub: "P" });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
