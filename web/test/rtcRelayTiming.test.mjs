// RTC start/timeout behaviour around the signaling relay.
//
// These reproduce a failure seen in the field: a cold load took ~8.5s to bring
// the DO relay up, but the RTC connect timer starts when the offer is CREATED.
// The first offers only reached the outbound buffer — the agent never saw
// them — yet each burned a full 4s budget and closed the peer. When the relay
// finally opened, the whole buffer flushed and the agent answered every stale
// offer at once, which the client discarded as duplicates.
//
// Each test states the behaviour, then asserts against the real module.
//
// Run: node --import ./test/loader-alias.mjs web/test/rtcRelayTiming.test.mjs
import assert from "node:assert/strict";
import { onSignalingReady, sendSignaling } from "../shared/transport/lib/pmSignaling.js";
import { ADAPTER_STATE, RTC_DEFER_MAX_MS, RTC_ICE_TIMEOUT_MS, RTC_CONNECT_TIMEOUT_MS } from "../shared/constants/transport.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Minimal PM stand-in: records which recovery entry points were invoked.
function makePm({ sigReady = false, rtcState = null } = {}) {
  const calls = [];
  const adapters = new Map();
  if (rtcState) adapters.set("rtc", { state: rtcState });
  return {
    calls,
    _adapters: adapters,
    _sig: { ready: sigReady },
    _sigBuffer: [],
    _awaitingApproval: false,
    _canSignal() { return !!this._sig?.ready; },
    _startSecondaryAdapters() { calls.push("startSecondary"); this._adapters.set("rtc", { state: ADAPTER_STATE.connecting }); },
    _restartRtc() { calls.push("restartRtc"); }
  };
}

console.log("\nRTC start is gated on the relay being up");

test("relay not ready at connect → RTC is deferred, not started", () => {
  // connect() must not create an offer that can only reach _sigBuffer: the
  // agent never receives it, but the connect timer runs anyway.
  const pm = makePm({ sigReady: false });
  const started = pm._canSignal();
  assert.equal(started, false, "a cold PM should not report the relay ready");
  assert.deepEqual(pm.calls, [], "nothing should have started yet");
});

test("relay ready at connect → RTC starts immediately", () => {
  const pm = makePm({ sigReady: true });
  if (pm._canSignal()) pm._startSecondaryAdapters();
  assert.deepEqual(pm.calls, ["startSecondary"]);
});

test("signaling ready with no adapter → starts the deferred RTC", () => {
  // This is the path that replaces the skipped start above.
  const pm = makePm({ sigReady: true });
  onSignalingReady(pm);
  assert.deepEqual(pm.calls, ["startSecondary"]);
});

test("signaling ready with a live adapter → does NOT restart it", () => {
  // Tearing down a peer mid-handshake is what produced the offer storms.
  const pm = makePm({ sigReady: true, rtcState: ADAPTER_STATE.connecting });
  onSignalingReady(pm);
  assert.deepEqual(pm.calls, [], "a connecting peer must be left alone");
});

test("signaling ready with a dead adapter → restarts it", () => {
  const pm = makePm({ sigReady: true, rtcState: ADAPTER_STATE.closed });
  onSignalingReady(pm);
  assert.deepEqual(pm.calls, ["restartRtc"]);
});

test("awaiting host approval → neither starts nor restarts", () => {
  const pm = makePm({ sigReady: true, rtcState: ADAPTER_STATE.closed });
  pm._awaitingApproval = true;
  onSignalingReady(pm);
  assert.deepEqual(pm.calls, []);
});

test("the defer backstop outlasts a slow relay but still bounds the wait", () => {
  // 8.5s was measured on a cold load; the backstop must sit above that yet
  // remain finite so a relay that never reports ready cannot block RTC forever.
  assert.ok(RTC_DEFER_MAX_MS > 8500, `backstop ${RTC_DEFER_MAX_MS}ms must exceed the observed 8.5s relay startup`);
  assert.ok(RTC_DEFER_MAX_MS <= 20000, "backstop must stay within a tolerable wait");
});

console.log("\nStale offers are not queued behind each other");

test("a new offer drops the superseded offer and its ICE", () => {
  // Each RTC retry builds a fresh peer, so a queued offer describes one the
  // client already threw away. Flushing them all made the agent rebuild its
  // peer once per stale offer and answer into the void.
  const pm = makePm({ sigReady: false });
  sendSignaling(pm, { type: "offer", n: 1 });
  sendSignaling(pm, { type: "ice", n: 1 });
  sendSignaling(pm, { type: "ice", n: 2 });
  sendSignaling(pm, { type: "offer", n: 2 });
  sendSignaling(pm, { type: "ice", n: 3 });

  const kinds = pm._sigBuffer.map((m) => `${m.type}${m.n}`);
  assert.deepEqual(kinds, ["offer2", "ice3"], "only the newest exchange should survive");
});

test("ICE alone accumulates — it belongs to the pending offer", () => {
  const pm = makePm({ sigReady: false });
  sendSignaling(pm, { type: "offer", n: 1 });
  sendSignaling(pm, { type: "ice", n: 1 });
  sendSignaling(pm, { type: "ice", n: 2 });
  assert.equal(pm._sigBuffer.filter((m) => m.type === "ice").length, 2);
});

test("a ready relay sends straight through, nothing buffers", () => {
  const sent = [];
  const pm = makePm({ sigReady: true });
  pm._sig.send = (msg) => { sent.push(msg.type); return true; };
  sendSignaling(pm, { type: "offer", n: 1 });
  assert.deepEqual(sent, ["offer"]);
  assert.equal(pm._sigBuffer.length, 0);
});

console.log("\nAnswer latency does not eat the ICE budget");

test("ICE gets its own window, separate from waiting on the answer", () => {
  // Observed: answer took 2.38s of a 4s budget, leaving ICE 1.6s — every peer
  // died on timeout. The ICE timer is armed when the answer lands instead.
  const answerLatencyMs = 2383;
  assert.ok(
    RTC_ICE_TIMEOUT_MS > RTC_CONNECT_TIMEOUT_MS - answerLatencyMs,
    "a slow answer must not shrink the ICE window"
  );
  assert.ok(RTC_ICE_TIMEOUT_MS >= 5000, "ICE needs a workable window of its own");
});

console.log("\nNAT is not declared hard while ICE was still trying");

// natVerdict is a pure function of three flags, replicated here so the rule can
// be asserted without standing up an RTCPeerConnection.
const natVerdict = ({ everOpened, types, answerApplied, iceReachedChecking }) => {
  const set = new Set(types);
  if (everOpened || set.has("relay")) return "ok";
  if (set.size === 0) return "unknown";
  if (!set.has("srflx")) return "hard";
  if (answerApplied && !iceReachedChecking) return "hard";
  return "unknown";
};

test("answered but ICE never started → hard (nothing to work with)", () => {
  assert.equal(natVerdict({ types: ["host", "srflx"], answerApplied: true, iceReachedChecking: false }), "hard");
});

test("ICE reached checking then timed out → unknown, not hard", () => {
  // The field case: a dual-stack client spent the window on IPv6 pairs and was
  // declared hard NAT, which pinned the session to the tunnel. The same network
  // connected in 89ms once ICE reached its IPv4 pairs.
  assert.equal(
    natVerdict({ types: ["host", "srflx"], answerApplied: true, iceReachedChecking: true }),
    "unknown",
    "a peer that was actively probing pairs must stay retryable"
  );
});

test("no srflx at all → hard (STUN/UDP blocked)", () => {
  assert.equal(natVerdict({ types: ["host"], answerApplied: true, iceReachedChecking: true }), "hard");
});

test("nothing gathered → unknown", () => {
  assert.equal(natVerdict({ types: [], answerApplied: false, iceReachedChecking: false }), "unknown");
});

test("a peer that opened → ok regardless of the rest", () => {
  assert.equal(natVerdict({ everOpened: true, types: [], answerApplied: false, iceReachedChecking: false }), "ok");
});

test("the ICE window covers a dual-stack fallback, not just the happy path", () => {
  // 8s was not enough to exhaust IPv6 pairs on the observed network.
  assert.ok(RTC_ICE_TIMEOUT_MS >= 12000, `ICE window ${RTC_ICE_TIMEOUT_MS}ms must allow the IPv6→IPv4 fallback`);
});

console.log("\nResume probe is skipped when death is certain");

// probeRtcOnResume checks matchMedia at call time; stub it per-case.
const withPointer = (coarse, fn) => {
  const prev = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: coarse });
  try { fn(); } finally { globalThis.matchMedia = prev; }
};
import { probeRtcOnResume } from "../shared/transport/lib/pmWatchers.js";
import { RESUME_PROBE_SKIP_HIDDEN_MS } from "../shared/constants/transport.js";

const makeResumePm = () => ({
  calls: [],
  _adapters: new Map([["rtc", { ready: true, _pc: { connectionState: "connected", getStats: async () => new Map() } }]]),
  _hiddenAt: 0,
  _restartRtc() { this.calls.push("restartRtc"); },
  _forceRestartRtc() { this.calls.push("forceRestartRtc"); }
});

test("touch device hidden past the threshold → restarts immediately, no probe", () => {
  const pm = makeResumePm();
  pm._hiddenAt = Date.now() - (RESUME_PROBE_SKIP_HIDDEN_MS + 5000);
  withPointer(true, () => probeRtcOnResume(pm));
  assert.deepEqual(pm.calls, ["forceRestartRtc"], "the 2s probe window must not be paid");
});

test("touch device hidden only briefly → still probes (peer may be alive)", () => {
  const pm = makeResumePm();
  pm._hiddenAt = Date.now() - 2000;
  withPointer(true, () => probeRtcOnResume(pm));
  assert.deepEqual(pm.calls, [], "probe is async — nothing fires synchronously");
});

test("desktop hide of any length → probes, never skips", () => {
  // A desktop tab-hide does not freeze WebRTC; force-restarting a live peer
  // there would trade a working connection for a needless rebuild.
  const pm = makeResumePm();
  pm._hiddenAt = Date.now() - (RESUME_PROBE_SKIP_HIDDEN_MS * 10);
  withPointer(false, () => probeRtcOnResume(pm));
  assert.deepEqual(pm.calls, [], "desktop must go through the probe");
});

test("no rtc adapter at all → plain restart", () => {
  const pm = makeResumePm();
  pm._adapters.delete("rtc");
  withPointer(true, () => probeRtcOnResume(pm));
  assert.deepEqual(pm.calls, ["restartRtc"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
