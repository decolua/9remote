// Characterization tests for the RTC recovery policy extracted from ProtocolManager.
// Drives the ladder exactly as _scheduleRtcRestart does, so a drift between the lib
// and the scheduler shows up here.
// Run: node --import ./test/loader-alias.mjs web/test/rtcRecoveryPolicy.test.mjs
import assert from "node:assert/strict";
import { RTC_RESTART, ADAPTER_STATE, RTC_CONNECT_TIMEOUT_MS } from "../shared/constants/transport.js";
import { nextRestartStep, restartTimerAction, restartRtcAction, sameNetwork } from "../shared/transport/lib/rtcRecoveryPolicy.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Drive the ladder the way the scheduler does: carry attempts/probeAttempts forward.
function runLadder({ verdict, ticks }) {
  const delays = [];
  let attempts = 0, probeAttempts = 0, givenUp = false;
  for (let i = 0; i < ticks; i++) {
    const step = nextRestartStep({ attempts, probeAttempts, verdict: () => verdict });
    if (step.giveUp) { givenUp = true; break; }
    delays.push(step.delay);
    attempts = step.attempts;
    probeAttempts = step.probeAttempts;
  }
  return { delays, givenUp, attempts, probeAttempts };
}

test("fast phase uses the tight backoff first", () => {
  const { delays } = runLadder({ verdict: "unknown", ticks: RTC_RESTART.maxAttempts });
  assert.deepEqual(delays, RTC_RESTART.backoffMs.slice(0, RTC_RESTART.maxAttempts));
});

test("probe phase escalates instead of a fixed interval", () => {
  const { delays } = runLadder({ verdict: "unknown", ticks: 6 });
  const probes = delays.slice(RTC_RESTART.maxAttempts);
  assert.deepEqual(probes, RTC_RESTART.probeBackoffMs.slice(0, probes.length));
  assert.ok(probes[1] > probes[0], "probe delay must grow");
});

test("hard NAT gives up shortly after the fast phase (bounded DO calls)", () => {
  const { givenUp, delays } = runLadder({ verdict: "hard", ticks: 100 });
  assert.ok(givenUp, "must give up on hard NAT");
  assert.ok(delays.length <= RTC_RESTART.maxAttempts + RTC_RESTART.classifyAfterProbes,
    `too many attempts before give-up: ${delays.length}`);
  assert.ok(delays.length < 10, `expected <10 signaling attempts, got ${delays.length}`);
});

test("soft NAT never gives up and stays under the cap", () => {
  const { givenUp, delays } = runLadder({ verdict: "unknown", ticks: 40 });
  assert.equal(givenUp, false);
  const cap = RTC_RESTART.probeBackoffMs.at(-1);
  for (const d of delays) assert.ok(d <= cap, `delay ${d} exceeded cap ${cap}`);
});

test("soft NAT resets the probe cadence so it never sticks at the cap", () => {
  const { delays } = runLadder({ verdict: "unknown", ticks: 12 });
  const probes = delays.slice(RTC_RESTART.maxAttempts);
  assert.ok(probes.filter((d) => d === RTC_RESTART.probeBackoffMs[0]).length >= 2,
    "cadence must restart from the first probe delay after a soft verdict");
});

test("verdict is only consulted at the classify boundary", () => {
  let calls = 0;
  const verdict = () => { calls++; return "unknown"; };
  let attempts = 0, probeAttempts = 0;
  for (let i = 0; i < RTC_RESTART.maxAttempts; i++) {
    const s = nextRestartStep({ attempts, probeAttempts, verdict });
    attempts = s.attempts; probeAttempts = s.probeAttempts;
  }
  assert.equal(calls, 0, "fast phase must not classify the NAT");
});

test("restartTimerAction: young peer waits, aged peer is torn down, dead peer restarts", () => {
  const now = 100_000;
  assert.equal(restartTimerAction({
    state: ADAPTER_STATE.connecting, connectingSince: now - 100, now, connectTimeoutMs: RTC_CONNECT_TIMEOUT_MS
  }), "wait");
  assert.equal(restartTimerAction({
    state: ADAPTER_STATE.connecting, connectingSince: now - RTC_CONNECT_TIMEOUT_MS - 1, now, connectTimeoutMs: RTC_CONNECT_TIMEOUT_MS
  }), "teardown");
  assert.equal(restartTimerAction({
    state: ADAPTER_STATE.closed, connectingSince: 0, now, connectTimeoutMs: RTC_CONNECT_TIMEOUT_MS
  }), "restart");
  // connectingSince missing → treated as age=now, i.e. past the timeout
  assert.equal(restartTimerAction({
    state: ADAPTER_STATE.connecting, connectingSince: undefined, now, connectTimeoutMs: RTC_CONNECT_TIMEOUT_MS
  }), "teardown");
});

test("restartRtcAction: guards stand down in priority order", () => {
  assert.equal(restartRtcAction({ testDisabled: true, givenUp: true, hasRtc: true, rtcState: ADAPTER_STATE.closed }), "skip-test-disabled");
  assert.equal(restartRtcAction({ testDisabled: false, givenUp: true, hasRtc: true, rtcState: ADAPTER_STATE.closed }), "skip-given-up");
  assert.equal(restartRtcAction({ testDisabled: false, givenUp: false, hasRtc: true, rtcState: ADAPTER_STATE.connecting }), "skip-in-flight");
  assert.equal(restartRtcAction({ testDisabled: false, givenUp: false, hasRtc: true, rtcState: ADAPTER_STATE.open }), "skip-in-flight");
  assert.equal(restartRtcAction({ testDisabled: false, givenUp: false, hasRtc: false, rtcState: undefined }), "start-fresh");
  assert.equal(restartRtcAction({ testDisabled: false, givenUp: false, hasRtc: true, rtcState: ADAPTER_STATE.closed }), "restart");
});

test("sameNetwork compares on the /24 (carrier NAT neighbours)", () => {
  assert.equal(sameNetwork("203.0.113.7", "203.0.113.99"), true);
  assert.equal(sameNetwork("203.0.113.7", "203.0.114.7"), false);
  assert.equal(sameNetwork("203.0.113.7", null), false);
  assert.equal(sameNetwork(null, null), false);
  assert.equal(sameNetwork("2001:db8::1", "2001:db8::2"), false, "IPv6 has no 4 dotted parts");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
