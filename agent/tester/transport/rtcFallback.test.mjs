// Scenario test for _sendControl RTC→WS control fallback.
// When the RTC adapter is "ready" but its DC silently dies (sendMessage returns false
// without throwing — node-datachannel can push into a dead SCTP stack during ice
// "disconnected" before onClosed fires), control messages (e.g. "output") must fall
// back to WS instead of being dropped. Otherwise the client (already on WS) never
// receives server output until F5 replays scrollback.
// Run: node tester/transport/rtcFallback.test.mjs
import assert from "node:assert";
import { ProtocolManager } from "../../transport/ProtocolManager.js";
import { CHANNELS } from "../../lib/transportConstants.js";

// Fake adapter — records control sends, controllable return value.
function makeAdapter(id, { ready = true, controlReturn = true } = {}) {
  const sent = [];
  return {
    sent,
    constructor: { id, priority: { control: 50, binary: 100 } },
    state: ready ? "open" : "closed",
    get ready() { return this.state === "open"; },
    supports: () => true,
    send: (channel, payload) => {
      if (channel === CHANNELS.control) {
        sent.push(payload);
        return controlReturn;
      }
      return true;
    }
  };
}

const pm = new ProtocolManager(
  { id: "test", on: () => {}, listeners: () => [], connected: true },
  { enableWebRTC: true, maxControlBuffer: 500 }
);

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// C1 — RTC preferred + ready, but DC silently dead (send returns false) → fallback WS.
// This is the bug: agent keeps pushing "output" into a dead RTC while client already
// fell back to WS → output lost, terminal appears frozen.
{
  const rtc = makeAdapter("rtc", { ready: true, controlReturn: false });
  const ws = makeAdapter("ws", { ready: true });
  pm._adapters = new Map([["rtc", rtc], ["ws", ws]]);
  pm._profile.channels.control.prefer = "rtc";

  pm._sendControl("output", [{ sessionId: "s1", data: "x" }]);

  check("C1: ws received fallback control", ws.sent.length === 1, `ws.sent=${ws.sent.length}`);
  check("C1: fallback event is output", ws.sent[0]?.event === "output");
  check("C1: rtc attempted (then failed)", rtc.sent.length === 1, `rtc.sent=${rtc.sent.length}`);
}

// C2 — RTC healthy (send returns true) → only RTC, WS untouched.
{
  const rtc = makeAdapter("rtc", { ready: true, controlReturn: true });
  const ws = makeAdapter("ws", { ready: true });
  pm._adapters = new Map([["rtc", rtc], ["ws", ws]]);
  pm._profile.channels.control.prefer = "rtc";

  pm._sendControl("output", [{ sessionId: "s2", data: "y" }]);

  check("C2: rtc received control", rtc.sent.length === 1, `rtc.sent=${rtc.sent.length}`);
  check("C2: ws untouched", ws.sent.length === 0, `ws.sent=${ws.sent.length}`);
}

// C3 — RTC dead, WS also dead → buffer (don't lose the message).
{
  const rtc = makeAdapter("rtc", { ready: false, controlReturn: false });
  pm._adapters = new Map([["rtc", rtc]]); // no ws
  pm._profile.channels.control.prefer = "rtc";

  pm._sendControl("output", [{ sessionId: "s3", data: "z" }]);

  check("C3: buffered when no adapter can deliver", pm._buffer.length === 1, `buffer=${pm._buffer.length}`);
}

// C4 — _sendAck: RTC dead (send false) → ack falls back to WS with ackId in envelope.
// Symmetric to control fallback: client RTC may die between request and ack arrival on
// the agent, so the ack must ride WS or the client request hangs until the 30s drop.
{
  const rtc = makeAdapter("rtc", { ready: true, controlReturn: false });
  const ws = makeAdapter("ws", { ready: true });
  pm._adapters = new Map([["rtc", rtc], ["ws", ws]]);

  pm._sendAck("a1", [{ ok: true }]);

  check("C4: ws received ack fallback", ws.sent.length === 1, `ws.sent=${ws.sent.length}`);
  check("C4: ack envelope event", ws.sent[0]?.event === "__ack", `event=${ws.sent[0]?.event}`);
  check("C4: ackId preserved in envelope", ws.sent[0]?.ackId === "a1", `ackId=${ws.sent[0]?.ackId}`);
  check("C4: ack args preserved", ws.sent[0]?.args[0]?.ok === true);
}

// C5 — _sendAck: RTC healthy → ack only via RTC, WS untouched.
{
  const rtc = makeAdapter("rtc", { ready: true, controlReturn: true });
  const ws = makeAdapter("ws", { ready: true });
  pm._adapters = new Map([["rtc", rtc], ["ws", ws]]);

  pm._sendAck("a2", [{ ok: true }]);

  check("C5: rtc received ack", rtc.sent.length === 1, `rtc.sent=${rtc.sent.length}`);
  check("C5: ws untouched", ws.sent.length === 0, `ws.sent=${ws.sent.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
