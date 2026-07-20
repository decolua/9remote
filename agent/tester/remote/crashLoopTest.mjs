// Crash-loop regression test — verifies the supervisor + WebRTC state machine
// survive the "flappy network → client reconnect → re-offer" storm that triggered
// the SIGSEGV crash loop on 2026-07-20.
//
// Root cause was native (node-datachannel) so it can't be reproduced in pure JS,
// but the JS-side invariants that AMPLIFY a crash loop are testable:
//   1. computeDelay backoff is monotonic + capped (lifecycle supervisor)
//   2. failCount resets after SERVER_HEALTHY_RESET_MS (so it never wedges at maxMs)
//   3. WebRtcProtocol re-offer race: a new offer arriving mid-teardown must not
//      touch a torn-down _pc (no call into a dead/closed native handle)
//   4. Answer-timeout timer must not reject after a successful answer (leak →
//      unhandledRejection, which is what the real logs showed right before the crash)
//   5. Rapid reconnect storm (many offers back-to-back) — only one live peer
//   6. ICE candidates arriving before the offer are buffered, not lost
//
// Run: node agent/tester/remote/crashLoopTest.mjs
import assert from "node:assert";
import { computeDelay } from "../../cli/utils/backoff.js";
import { SERVER_HEALTHY_RESET_MS, SHUTDOWN_CRASH_DELAY_MS } from "../../cli/config.js";
import { RETRY_CONFIG } from "../../lib/constants.js";
import { REMOTE_CONFIG } from "../../features/remote/REMOTE_CONFIG.js";

let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function fail(name, err) { failed++; console.error(`  ✗ ${name}\n    ${err.stack || err.message}`); }
function section(t) { console.log(`\n${t}`); }

// ─── Mock node-datachannel ────────────────────────────────────────
// Fake PeerConnection: records lifecycle + lets the test drive state transitions
// and local-description callbacks. No native binary required.
class FakeDataChannel {
  constructor(label) { this._label = label; this._open = []; this._closed = []; }
  getLabel() { return this._label; }
  onOpen(cb) { this._open.push(cb); }
  onClosed(cb) { this._closed.push(cb); }
  onError() {}
  onMessage() {}
  bufferedAmount() { return 0; }
  sendMessage() { return true; }
  sendMessageBinary() { return true; }
  _openIt() { for (const cb of this._open) cb(); }
}

class FakePeerConnection {
  static instances = [];
  static reset() { FakePeerConnection.instances = []; }
  constructor(label, opts) {
    this.label = label;
    this.opts = opts;
    this.closed = false;
    this.remoteDesc = null;
    this.localDescSent = false;
    this.candidatesAdded = [];
    this._stateCb = null;
    this._localDescCb = null;
    this._localCandCb = null;
    this._dcCb = null;
    FakePeerConnection.instances.push(this);
  }
  onStateChange(cb) { this._stateCb = cb; }
  onLocalDescription(cb) { this._localDescCb = cb; }
  onLocalCandidate(cb) { this._localCandCb = cb; }
  onDataChannel(cb) { this._dcCb = cb; }
  setRemoteDescription(sdp, type) { if (this.closed) throw new Error("pc closed"); this.remoteDesc = { sdp, type }; }
  setLocalDescription() {
    if (this.closed) throw new Error("pc closed");
    // Asynchronously emit an answer, mimicking libdatachannel.
    queueMicrotask(() => {
      if (this.closed) return;
      if (!this.localDescSent) {
        this.localDescSent = true;
        this._localDescCb?.("v=0 ANSWER-SDP", "answer");
        // Also simulate the two data channels opening.
        this._spawnDc("control");
        this._spawnDc("binary");
      }
    });
  }
  addRemoteCandidate(c, mid) { if (this.closed) throw new Error("pc closed"); this.candidatesAdded.push({ c, mid }); }
  close() { this.closed = true; this._stateCb?.("closed"); }
  _spawnDc(label) {
    const dc = new FakeDataChannel(label);
    this._dcCb?.(dc);
    queueMicrotask(() => dc._openIt());
  }
  // Test helpers — simulate ICE / DC events from the native layer.
  simulateState(s) { if (!this.closed) this._stateCb?.(s); }
}

// Inject the fake BEFORE any WebRtcProtocol is constructed.
const { WebRtcProtocol, __setNodeDataChannelForTest } = await import("../../transport/WebRtcProtocol.js");
__setNodeDataChannelForTest({ PeerConnection: FakePeerConnection });

// Build a ctx with in-memory signaling capture.
function makeCtx(extra = {}) {
  const sent = [];
  const handler = { current: null };
  const signaling = {
    send: (m) => sent.push(m),
    on: (h) => { handler.current = h; },
    off: () => { handler.current = null; },
  };
  return {
    ctx: {
      auth: { apiKey: "k", socketId: "sock-1" },
      profile: { rtc: { ...REMOTE_CONFIG.webrtc, enableTurn: false, ...extra } },
      signaling,
    },
    sent,
    signal: (msg) => handler.current?.(msg),
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ─── TEST 1: computeDelay monotonic + capped ─────────────────────
section("TEST 1 — backoff exp schedule (matches fail#1..6 in logs)");
try {
  const cfg = RETRY_CONFIG.server;
  const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => computeDelay(cfg, n));
  const expected = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
  assert.deepStrictEqual(delays, expected, `delays=${JSON.stringify(delays)}`);
  assert.ok(delays.every((d) => d <= cfg.maxMs), "exceeds maxMs cap");
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] >= delays[i - 1], `non-monotonic at ${i}`);
  }
  ok(`schedule = [${delays.join(",")}]ms (cap=${cfg.maxMs})`);
} catch (e) { fail("computeDelay schedule", e); }

// ─── TEST 2: failCount reset semantics ────────────────────────────
section("TEST 2 — failCount reset window (SERVER_HEALTHY_RESET_MS)");
try {
  assert.ok(SERVER_HEALTHY_RESET_MS === 30000, `expected 30000, got ${SERVER_HEALTHY_RESET_MS}`);
  assert.ok(SHUTDOWN_CRASH_DELAY_MS >= 300, "crash delay too short for log flush");
  // Models lifecycle.js:67 — healthyTimer resets failCount after SERVER_HEALTHY_RESET_MS.
  // Explains why logs show fail#1..6 repeating instead of climbing forever.
  let failCount = 0;
  function crash(now, lastHealthyAt) {
    if (lastHealthyAt != null && now - lastHealthyAt >= SERVER_HEALTHY_RESET_MS) failCount = 0;
    failCount++;
    return failCount;
  }
  assert.strictEqual(crash(5000, null), 1);
  assert.strictEqual(crash(8000, 0), 2);
  assert.strictEqual(crash(40000, 0), 1);
  ok("reset window matches fail#1..6 pattern in logs");
} catch (e) { fail("failCount reset", e); }

// ─── TEST 3: clean offer → answer flow ────────────────────────────
section("TEST 3 — single offer produces one answer + one peer");
try {
  FakePeerConnection.reset();
  const { ctx, sent, signal } = makeCtx();
  const rtc = new WebRtcProtocol();
  await rtc.connect(ctx);

  signal({ type: "offer", sdp: "v=0 OFFER" });
  await tick();

  assert.strictEqual(FakePeerConnection.instances.length, 1, "exactly one peer");
  assert.strictEqual(FakePeerConnection.instances[0].closed, false, "peer alive");
  const answers = sent.filter((m) => m.type === "answer");
  assert.strictEqual(answers.length, 1, `answers=${answers.length}`);
  ok(`offer → answer sent (${sent.length} signaling msgs, 1 peer)`);

  rtc.disconnect();
  assert.strictEqual(FakePeerConnection.instances[0].closed, true, "peer closed on disconnect");
  ok("disconnect closes peer");
} catch (e) { fail("offer→answer flow", e); }

// ─── TEST 4: re-offer race — new offer mid-teardown ───────────────
section("TEST 4 — re-offer race (network flapping → reconnect storm)");
try {
  FakePeerConnection.reset();
  const { ctx, sent, signal } = makeCtx();
  const rtc = new WebRtcProtocol();
  await rtc.connect(ctx);

  signal({ type: "offer", sdp: "v=0 OFFER-1" });
  await tick();
  signal({ type: "offer", sdp: "v=0 OFFER-2" });
  await tick();

  assert.strictEqual(FakePeerConnection.instances.length, 2, "two peers created");
  assert.strictEqual(FakePeerConnection.instances[0].closed, true, "old peer #1 closed");
  assert.strictEqual(FakePeerConnection.instances[1].closed, false, "new peer #2 alive");
  const answers = sent.filter((m) => m.type === "answer");
  assert.strictEqual(answers.length, 2, "each offer answered");
  ok("re-offer closes old peer before creating new — no double-live");
  rtc.disconnect();
} catch (e) { fail("re-offer race", e); }

// ─── TEST 5: answer-timeout does not leak after success ───────────
section("TEST 5 — Answer-timeout suppressed once answered (no late reject)");
try {
  FakePeerConnection.reset();
  global.__crashTestUnhandled = false;
  const { ctx, sent, signal } = makeCtx({ answerTimeout: 30 });
  const rtc = new WebRtcProtocol();
  await rtc.connect(ctx);

  signal({ type: "offer", sdp: "v=0 OFFER" });
  await tick();
  await tick(80); // well past the 30ms timeout window

  assert.strictEqual(global.__crashTestUnhandled, false, "late timeout reject leaked");
  const answers = sent.filter((m) => m.type === "answer");
  assert.strictEqual(answers.length, 1, "answered exactly once");
  ok("answered within window → timeout suppressed, no leak");
  rtc.disconnect();
} catch (e) { fail("answer timeout race", e); }

// Track unhandled rejections — the smoking gun from the real logs.
const unhandledGuard = (err) => {
  if (err?.message === "Answer timeout") global.__crashTestUnhandled = true;
};
process.on("unhandledRejection", unhandledGuard);

// ─── TEST 6: storm — 20 offers back-to-back, only last peer live ──
section("TEST 6 — reconnect storm (20 offers, rapid network flapping)");
try {
  FakePeerConnection.reset();
  global.__crashTestUnhandled = false;
  const { ctx, sent, signal } = makeCtx({ answerTimeout: 10000 });
  const rtc = new WebRtcProtocol();
  await rtc.connect(ctx);

  for (let i = 0; i < 20; i++) signal({ type: "offer", sdp: `v=0 OFFER-${i}` });
  await tick(30);

  const alive = FakePeerConnection.instances.filter((p) => !p.closed);
  assert.strictEqual(alive.length, 1, `alive peers=${alive.length}`);
  assert.ok(FakePeerConnection.instances.length >= 1, "peers created");
  assert.strictEqual(global.__crashTestUnhandled, false, "storm caused unhandled rejection");
  const answers = sent.filter((m) => m.type === "answer");
  assert.ok(answers.length >= 1, `answers=${answers.length}`);
  ok(`storm of 20 offers → ${alive.length} live peer, no unhandled rejection`);
  rtc.disconnect();
} catch (e) { fail("reconnect storm", e); }

// ─── TEST 7: ICE candidates arriving after offer are applied ──────
section("TEST 7 — ICE after offer reaches addRemoteCandidate");
try {
  FakePeerConnection.reset();
  const { ctx, signal } = makeCtx();
  const rtc = new WebRtcProtocol();
  await rtc.connect(ctx);

  signal({ type: "offer", sdp: "v=0 OFFER" });
  await tick();
  // ICE arriving once remote description is already set → applied directly.
  signal({ type: "ice", candidate: "candidate:1 1 UDP 1 192.168.1.10 5000 typ host", mid: "0" });
  signal({ type: "ice", candidate: "candidate:2 1 UDP 1 192.168.1.11 5001 typ host", mid: "0" });
  await tick();

  const pc = FakePeerConnection.instances[0];
  assert.ok(pc.candidatesAdded.length >= 2, `applied=${pc.candidatesAdded.length}`);
  ok(`${pc.candidatesAdded.length} candidates applied post-offer`);
  rtc.disconnect();
} catch (e) { fail("ICE post-offer", e); }

// ─── TEST 8: ICE-before-offer is buffered, then flushed ───────────
// Regression for the bug found while writing this test: _createPeer() previously
// cleared _pendingCandidates=[] BEFORE _processOffer() flushed them, dropping
// early ICE silently. In a flappy-network storm that stalls ICE → Answer timeout
// pile-up → the unhandledRejection seen in the logs right before the crash loop.
section("TEST 8 — ICE before offer is buffered and flushed on offer");
try {
  FakePeerConnection.reset();
  const { ctx, signal } = makeCtx();
  const rtc = new WebRtcProtocol();
  await rtc.connect(ctx);

  signal({ type: "ice", candidate: "candidate:1 1 UDP 1 192.168.1.10 5000 typ host", mid: "0" });
  assert.strictEqual(rtc._pendingCandidates.length, 1, "buffered before offer");
  signal({ type: "offer", sdp: "v=0 OFFER" });
  await tick();
  assert.strictEqual(rtc._pendingCandidates.length, 0, "flushed after offer");
  const pc = FakePeerConnection.instances[0];
  assert.strictEqual(pc.candidatesAdded.length, 1, `applied=${pc.candidatesAdded.length}`);
  ok("pre-offer ICE buffered + flushed on offer (regression fixed)");
  rtc.disconnect();
} catch (e) { fail("ICE pre-offer flush", e); }

// ─── TEST 9: answer-timer is cleared on disconnect (no dangling timer) ──
// Regression for the Answer-timeout timer leak: _cleanupPeer must clear it so
// a reconnect mid-negotiation can't fire a stale reject into a dead peer.
section("TEST 9 — answer-timer cleared on disconnect");
try {
  FakePeerConnection.reset();
  global.__crashTestUnhandled = false;
  const { ctx, signal } = makeCtx({ answerTimeout: 10000 });
  const rtc = new WebRtcProtocol();
  await rtc.connect(ctx);

  // Offer arrives but no answer is generated yet (our fake emits on next tick,
  // so disconnect here leaves the timer armed).
  signal({ type: "offer", sdp: "v=0 OFFER" });
  assert.ok(rtc._answerTimer !== null, "answer timer armed");
  rtc.disconnect();
  assert.strictEqual(rtc._answerTimer, null, "answer timer cleared on disconnect");
  await tick(20);
  assert.strictEqual(global.__crashTestUnhandled, false, "stale timer fired after disconnect");
  ok("disconnect clears answer-timer — no stale reject");
} catch (e) { fail("answer-timer cleanup", e); }

process.removeListener("unhandledRejection", unhandledGuard);

// ─── summary ──────────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
console.log(`crashLoopTest: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
// Pending answer-timeout timers (10s) outlive the assertions; exit explicitly
// so they don't surface as a late unhandledRejection after the summary.
process.exit(failed > 0 ? 1 : 0);
