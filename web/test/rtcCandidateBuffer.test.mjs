// ICE candidates that arrive between answer-received and answer-applied must be
// buffered, not dropped.
//
// addIceCandidate before setRemoteDescription completes throws InvalidStateError,
// and the handler swallowed it — so candidates landing in that window vanished.
// The agent sends its answer and its candidates back-to-back (they crossed
// within 6ms in the field log), so whether the host candidate survived was a
// coin flip per attempt: lose it and the only remaining pair was srflx through
// a carrier NAT that never connects — flaky "sometimes works, sometimes not" RTC.
//
// Run: node --import ./test/loader-alias.mjs web/test/rtcCandidateBuffer.test.mjs
import assert from "node:assert/strict";
import { WebRtcProtocol } from "../shared/transport/WebRtcProtocol.js";

// Node has no WebRTC globals; _handleSignal only constructs these wrappers.
globalThis.RTCIceCandidate = class { constructor(c) { Object.assign(this, c); } };
globalThis.RTCSessionDescription = class { constructor(c) { Object.assign(this, c); } };

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// A protocol instance driven by hand: _handleSignal only touches _pc via
// setRemoteDescription/addIceCandidate, so a recording stub stands in for the
// browser's RTCPeerConnection.
function makePeer() {
  const added = [];
  const remoteDescAppliedAt = { value: 0 };
  let applyDelay = Promise.resolve();
  const pc = {
    signalingState: "have-local-offer",
    setRemoteDescription: async () => { await applyDelay; remoteDescAppliedAt.value = Date.now(); },
    addIceCandidate: async (c) => {
      if (!remoteDescAppliedAt.value) throw new Error("InvalidStateError (no remote description)");
      added.push(c);
    }
  };
  const rtc = new WebRtcProtocol();
  rtc._pc = pc;
  rtc._answerApplied = false;
  return { rtc, added, controls: { delayAnswer: (p) => { applyDelay = p; } } };
}

const cand = (i) => ({ type: "ice", candidate: `candidate:${i}`, mid: "0" });

console.log("\nCandidates racing the answer");

await test("candidates arriving before the answer applies are buffered, then flushed", async () => {
  const { rtc, added, controls } = makePeer();
  let release; controls.delayAnswer(new Promise((r) => { release = r; }));

  const icePromise = rtc._handleSignal(cand(1));
  await rtc._handleSignal(cand(2));
  assert.equal(added.length, 0, "nothing may reach addIceCandidate before the remote description");

  const answerJob = rtc._handleSignal({ type: "answer", sdp: "v=0..." });
  await new Promise((r) => setTimeout(r, 5));
  release();
  await Promise.all([answerJob, icePromise]);

  assert.ok(rtc._answerApplied, "answer should have applied");
  assert.equal(added.length, 2, "both racing candidates must be added after the answer");
});

await test("candidates arriving after the answer go straight through", async () => {
  const { rtc, added } = makePeer();
  await rtc._handleSignal({ type: "answer", sdp: "v=0..." });
  await rtc._handleSignal(cand(1));
  assert.equal(added.length, 1);
});

await test("buffer is per-attempt — a new peer starts clean", async () => {
  const { rtc } = makePeer();
  await rtc._handleSignal(cand(1));            // buffered on the old peer
  assert.equal(rtc._pendingCandidates.length, 1);
  rtc._answerApplied = false;                  // what connect() does for the retry
  rtc._pendingCandidates = [];
  assert.equal(rtc._pendingCandidates.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
