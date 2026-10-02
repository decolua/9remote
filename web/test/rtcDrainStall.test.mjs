// SCTP blackhole: the control DC reports "open" while nothing drains. The
// stall detector must close the peer after RTC_DC_STALL_SENDS consecutive
// sends whose bufferedAmount never decreased for at least RTC_DC_STALL_WINDOW_MS
// — and must NOT close on a same-tick login burst, which queues several sends
// before the link transmits a single byte.
//
// Run: node --import ./test/loader-alias.mjs web/test/rtcDrainStall.test.mjs
import assert from "node:assert/strict";
import { WebRtcProtocol } from "../shared/transport/WebRtcProtocol.js";
import { ADAPTER_STATE, RTC_DC_STALL_SENDS, RTC_DC_STALL_WINDOW_MS } from "../shared/constants/transport.js";

globalThis.RTCIceCandidate = class { constructor(c) { Object.assign(this, c); } };
globalThis.RTCSessionDescription = class { constructor(c) { Object.assign(this, c); } };

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Fake control DC: every send queues 40B; the test drains by hand between sends.
function makeDc() {
  return {
    readyState: "open",
    amt: 0,
    get bufferedAmount() { return this.amt; },
    send() { this.amt += 40; },
    close() {}
  };
}

function makePeer() {
  const rtc = new WebRtcProtocol();
  rtc._dcControl = makeDc();
  return rtc;
}

const input = { event: "input", args: ["a"] };

await test("healthy path: draining between sends never closes", async () => {
  const rtc = makePeer();
  for (let i = 0; i < 6; i++) {
    assert.equal(rtc.send("control", input), true);
    rtc._dcControl.amt = 0; // link drained everything
  }
  assert.equal(rtc.state, ADAPTER_STATE.idle, "no close event fired");
  assert.equal(rtc._dcStallCount, 0);
});

await test("login burst: same-tick sends with zero drain do NOT close", async () => {
  const rtc = makePeer();
  for (let i = 0; i < 10; i++) {
    assert.equal(rtc.send("control", input), true, `burst send #${i + 1} must go through`);
  }
  assert.equal(rtc.state, ADAPTER_STATE.idle, "burst is not a blackhole — peer stays up");
});

await test(`blackhole: ${RTC_DC_STALL_SENDS} zero-drain sends stuck ≥${RTC_DC_STALL_WINDOW_MS}ms close the peer`, async () => {
  const rtc = makePeer();
  rtc.send("control", input); // queues the first bytes
  // Simulate the stuck window: backdate the first zero-drain observation.
  for (let i = 0; i < RTC_DC_STALL_SENDS - 1; i++) {
    rtc.send("control", input);
    rtc._dcStallSince -= RTC_DC_STALL_WINDOW_MS; // these sends are >window apart
  }
  const after = rtc.send("control", input);
  assert.equal(after, false, "send refused once count AND stuck-time thresholds are met");
  assert.equal(rtc.state, ADAPTER_STATE.closed);
  assert.equal(rtc._dcControl, null, "peer torn down");
});

await test("partial drain resets the stall counter", async () => {
  const rtc = makePeer();
  rtc.send("control", input); // queues 40
  rtc._dcControl.amt = 20; // half drained — link is alive
  rtc.send("control", input);
  assert.equal(rtc._dcStallCount, 0, "any drain resets the counter");
  assert.equal(rtc.state, ADAPTER_STATE.idle);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
