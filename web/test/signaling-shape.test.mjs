// Contract test for signaling message shape — mirrors the sigData/encode/decode
// mapping used by both SignalingClient (web + agent) and the DO relay.
// Outbound: {to, type, payload: sigData(msg)}. Inbound: {type, ...payload}.
// DO relay forwards {type, payload} verbatim. Client reconstructs {type, ...payload}.
//
// If this breaks, offer/answer/ICE round-trip through the DO is corrupted.
// Run: node web/test/signaling-shape.test.mjs

const OTHER_ROLE = { agent: "client", client: "agent" };

function sigData(msg) {
  if (msg.type === "offer" || msg.type === "answer") return { sdp: msg.sdp };
  if (msg.type === "ice") return { candidate: msg.candidate, mid: msg.mid };
  return msg; // error → {message}
}

// SignalingClient.send outbound shape
function encodeOutbound(role, msg) {
  return { to: OTHER_ROLE[role], from: role, type: msg.type, payload: sigData(msg) };
}

// DO relay forwards (strips `to`, keeps from + type + payload)
function relayForward(outbound) {
  return JSON.stringify({ from: outbound.from, type: outbound.type, payload: outbound.payload });
}

// SignalingClient inbound reconstruction
function decodeInbound(text) {
  const { type, payload } = JSON.parse(text);
  return { type, ...payload };
}

let pass = 0, fail = 0;
const assert = (cond, label) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  cond ? pass++ : fail++;
};

const CASES = [
  { type: "offer", sdp: "v=0\r\no=- 123 IN IP4 0.0.0.0\r\ns=-\r\n" },
  { type: "answer", sdp: "v=0\r\no=- 456 IN IP4 1.1.1.1\r\ns=-\r\n" },
  { type: "ice", candidate: "candidate:842163049 1 udp 1677729535 192.0.2.3 61415 typ srflx", mid: "0" },
  { type: "error", message: "Answer timeout" }
];

for (const orig of CASES) {
  // client → DO → agent
  const out = encodeOutbound("client", orig);
  const wire = relayForward(out);
  const decoded = decodeInbound(wire);

  assert(decoded.type === orig.type, `${orig.type}: type preserved`);
  for (const key of Object.keys(orig)) {
    assert(decoded[key] === orig[key], `${orig.type}: ${key} round-trips unchanged`);
  }
  assert(out.to === "agent", `${orig.type}: addressed to opposite role`);
}

// ICE mid missing → sigData still works (mid undefined)
const iceNoMid = sigData({ type: "ice", candidate: "x" });
assert(iceNoMid.candidate === "x" && iceNoMid.mid === undefined, "ice without mid ok");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
