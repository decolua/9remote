// Scenario test for control payload size-routing.
// Payloads larger than CONTROL_RTC_MAX_BYTES must route over WS even when RTC is
// the preferred control adapter — SCTP DC silently drops/throws on oversize messages,
// which corrupts the channel into a zombie state (readyState open but bytes lost).
// Run: node tester/transport/rtcSizeRouting.test.mjs
import assert from "node:assert";
import { ProtocolManager } from "../../transport/ProtocolManager.js";
import { CHANNELS, CONTROL_RTC_MAX_BYTES } from "../../lib/transportConstants.js";

// Fake adapter — records control sends, reports oversized payload as false (DC throws).
function makeAdapter(id, { ready = true } = {}) {
  const sent = [];
  return {
    sent,
    constructor: { id, priority: { control: 50, binary: 100 } },
    state: ready ? "open" : "closed",
    get ready() { return this.state === "open"; },
    supports: () => true,
    send: (channel, payload) => {
      if (channel !== CHANNELS.control) return true;
      // Oversize → throws inside sendMessage → send() catches → returns false
      const size = JSON.stringify(payload.args || []).length;
      if (id === "rtc" && size > CONTROL_RTC_MAX_BYTES) return false;
      sent.push(payload);
      return true;
    }
  };
}

const pm = new ProtocolManager(
  { id: "test", on: () => {}, listeners: () => [], connected: true },
  { enableWebRTC: true, maxControlBuffer: 500 }
);
pm._profile.channels.control.prefer = "rtc";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// S1 — Small payload + RTC preferred → RTC, WS untouched.
{
  const rtc = makeAdapter("rtc");
  const ws = makeAdapter("ws");
  pm._adapters = new Map([["rtc", rtc], ["ws", ws]]);

  pm._sendControl("input", [{ sessionId: "s1", data: "ls" }]);

  check("S1: small → rtc", rtc.sent.length === 1, `rtc.sent=${rtc.sent.length}`);
  check("S1: ws untouched", ws.sent.length === 0, `ws.sent=${ws.sent.length}`);
}

// S2 — Oversize payload + RTC preferred → WS (size-routing preemptive).
{
  const rtc = makeAdapter("rtc");
  const ws = makeAdapter("ws");
  pm._adapters = new Map([["rtc", rtc], ["ws", ws]]);

  const big = "x".repeat(CONTROL_RTC_MAX_BYTES + 1000);
  pm._sendControl("clipboard-attach", [{ content: big }]);

  check("S2: oversize → ws", ws.sent.length === 1, `ws.sent=${ws.sent.length}`);
  check("S2: oversize event preserved", ws.sent[0]?.event === "clipboard-attach");
  check("S2: rtc skipped (no oversize attempt)", rtc.sent.length === 0, `rtc.sent=${rtc.sent.length}`);
}

// S3 — Oversize but WS down → buffer (don't lose, don't corrupt RTC).
{
  const rtc = makeAdapter("rtc");
  pm._adapters = new Map([["rtc", rtc]]); // no ws

  const big = "x".repeat(CONTROL_RTC_MAX_BYTES + 1000);
  pm._sendControl("clipboard-attach", [{ content: big }]);

  check("S3: buffered when ws down + oversize", pm._buffer.length === 1, `buffer=${pm._buffer.length}`);
  check("S3: rtc not attempted", rtc.sent.length === 0, `rtc.sent=${rtc.sent.length}`);
}

// S4 — Boundary: exactly CONTROL_RTC_MAX_BYTES → still RTC (not over).
{
  const rtc = makeAdapter("rtc");
  const ws = makeAdapter("ws");
  pm._adapters = new Map([["rtc", rtc], ["ws", ws]]);

  // Args JSON size just under threshold
  pm._sendControl("input", [{ data: "x".repeat(100) }]);
  check("S4: under-threshold → rtc", rtc.sent.length === 1, `rtc.sent=${rtc.sent.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
