// Tests for RTC probe cadence + NAT give-up (anti DO-spam).
// Drives the REAL scheduler policy (lib/rtcRecoveryPolicy) and mirrors
// WebRtcProtocol.natVerdict, then attacks them with the cases that cost real
// money: symmetric NAT probing forever, STUN-blocked networks, and the re-arm
// paths that must NOT be lost (network change / long resume).
//
// Run: node --import ./test/loader-alias.mjs web/test/rtcNatGiveUp.test.mjs
import assert from "node:assert/strict";
import { RTC_RESTART } from "../shared/constants/transport.js";
import { nextRestartStep } from "../shared/transport/lib/rtcRecoveryPolicy.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ── natVerdict (mirror of WebRtcProtocol.natVerdict) ───────────────────────
// Deliberately NOT keyed on ICE "failed": _connectTimer closes the peer after
// RTC_CONNECT_TIMEOUT_MS (4s) while the browser needs 15-30s to declare failure,
// so an ice-failed-based verdict would never fire and symmetric NAT would probe
// the DO forever. The real signal is "host answered, yet the DC never opened".
const natVerdict = (types, { answered = false, opened = false } = {}) => {
  const s = new Set(types);
  if (opened || s.has("relay")) return "ok";
  if (s.size === 0) return "unknown";
  if (!s.has("srflx")) return "hard";
  return answered ? "hard" : "unknown";
};

test("relay candidate → ok (TURN works, never give up)", () => {
  assert.equal(natVerdict(["host", "srflx", "relay"], { answered: true }), "ok");
});

test("DC opened at least once → ok regardless of candidate mix", () => {
  assert.equal(natVerdict(["host", "srflx"], { answered: true, opened: true }), "ok");
});

test("answered but DC never opened, srflx present → hard (symmetric NAT)", () => {
  assert.equal(natVerdict(["host", "srflx"], { answered: true }), "hard");
});

test("no answer yet → unknown (host offline / DO drop, retry may work)", () => {
  assert.equal(natVerdict(["host", "srflx"], { answered: false }), "unknown");
});

test("only host candidates → hard (STUN/UDP blocked, answer irrelevant)", () => {
  assert.equal(natVerdict(["host"], { answered: false }), "hard");
  assert.equal(natVerdict(["host"], { answered: true }), "hard");
});

test("nothing gathered yet → unknown (never give up on no data)", () => {
  assert.equal(natVerdict([], { answered: false }), "unknown");
  assert.equal(natVerdict([], { answered: true }), "unknown");
});

test("prflx only → hard (peer-reflexive without srflx means no STUN path)", () => {
  assert.equal(natVerdict(["prflx"], { answered: true }), "hard");
});

test("host-offline loop is never mistaken for hard NAT", () => {
  // The common case that must stay retryable: host not yet in the DO room, so
  // no answer arrives. Verdict must be unknown so RTC keeps trying.
  for (let i = 0; i < 5; i++) {
    assert.equal(natVerdict(["host", "srflx"], { answered: false }), "unknown");
  }
});

// ── Probe cadence — drives the real policy used by _scheduleRtcRestart ─────
// Carries attempts/probeAttempts forward exactly as the scheduler does.
function runScheduler({ verdict, ticks }) {
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

test("fast phase uses the tight backoff first (answer normally <300ms)", () => {
  const { delays } = runScheduler({ verdict: "unknown", ticks: 3 });
  assert.deepEqual(delays, RTC_RESTART.backoffMs);
});

test("probe phase escalates instead of a fixed interval", () => {
  const { delays } = runScheduler({ verdict: "unknown", ticks: 6 });
  const probes = delays.slice(RTC_RESTART.maxAttempts);
  assert.deepEqual(probes, RTC_RESTART.probeBackoffMs.slice(0, probes.length));
  assert.ok(probes[1] > probes[0], "probe delay must grow");
});

test("hard NAT gives up shortly after the fast phase (bounded DO calls)", () => {
  const { givenUp, delays } = runScheduler({ verdict: "hard", ticks: 100 });
  assert.ok(givenUp, "must give up on hard NAT");
  // fast attempts + at most classifyAfterProbes probes, nothing like 100.
  assert.ok(delays.length <= RTC_RESTART.maxAttempts + RTC_RESTART.classifyAfterProbes,
    `too many attempts before give-up: ${delays.length}`);
});

test("hard NAT: total DO calls stay small vs the old always-30s loop", () => {
  const { delays } = runScheduler({ verdict: "hard", ticks: 1000 });
  // Old behaviour: 30s forever = 120 signaling round-trips/hour. New: single digits.
  assert.ok(delays.length < 10, `expected <10 signaling attempts, got ${delays.length}`);
});

test("soft NAT never gives up, and its cadence stays bounded by the cap", () => {
  const { givenUp, delays } = runScheduler({ verdict: "unknown", ticks: 40 });
  assert.equal(givenUp, false);
  const cap = RTC_RESTART.probeBackoffMs.at(-1);
  for (const d of delays) assert.ok(d <= cap, `delay ${d} exceeded cap ${cap}`);
});

test("soft NAT resets the probe cadence so it never sticks at the cap", () => {
  const { delays } = runScheduler({ verdict: "unknown", ticks: 12 });
  const probes = delays.slice(RTC_RESTART.maxAttempts);
  // After classifyAfterProbes probes the counter resets → the 30s step reappears.
  assert.ok(probes.filter((d) => d === RTC_RESTART.probeBackoffMs[0]).length >= 2,
    "cadence must restart from the first probe delay after a soft verdict");
});

// ── Re-arm is evidence-based, not time-based ───────────────────────────────
// The give-up is lifted only when a STUN probe reports a DIFFERENT public IP.
// Rule itself is unit-tested in stunProbe.test.mjs; here we pin the cost model:
// repeated resumes on the SAME network must never re-enter the retry ladder.
const simulateResumes = ({ ipSequence, giveUpIp }) => {
  let givenUp = true, calls = 0;
  for (const ip of ipSequence) {
    if (!givenUp) break;
    const rearm = ip != null && ip !== giveUpIp;
    if (rearm) { givenUp = false; calls += runScheduler({ verdict: "hard", ticks: 100 }).delays.length; }
  }
  return { givenUp, calls };
};

test("20 resumes on the same network cost ZERO DO calls", () => {
  const ip = "203.0.113.7";
  const { givenUp, calls } = simulateResumes({ ipSequence: Array(20).fill(ip), giveUpIp: ip });
  assert.equal(calls, 0, "same-IP resumes must not re-enter the retry ladder");
  assert.equal(givenUp, true, "give-up must survive same-network resumes");
});

test("failed STUN probes never lift the give-up (no evidence, no spend)", () => {
  const { givenUp, calls } = simulateResumes({ ipSequence: [null, null, null], giveUpIp: "203.0.113.7" });
  assert.equal(calls, 0);
  assert.equal(givenUp, true);
});

test("a real handover re-arms once and re-enters a BOUNDED ladder", () => {
  const { givenUp, calls } = simulateResumes({ ipSequence: ["198.51.100.4"], giveUpIp: "203.0.113.7" });
  assert.equal(givenUp, false, "different IP must re-arm");
  assert.ok(calls > 0 && calls < 10, `re-armed ladder must stay bounded, got ${calls}`);
});

// ── Config sanity ──────────────────────────────────────────────────────────

test("probe backoff is strictly increasing and capped at 5 minutes", () => {
  const b = RTC_RESTART.probeBackoffMs;
  for (let i = 1; i < b.length; i++) assert.ok(b[i] > b[i - 1], `not increasing at ${i}`);
  assert.ok(b.at(-1) <= 300000, "cap should not exceed 5 minutes");
});

test("classifyAfterProbes is small enough to bound wasted DO calls", () => {
  assert.ok(RTC_RESTART.classifyAfterProbes >= 1 && RTC_RESTART.classifyAfterProbes <= 5);
});

test("no time-based re-arm knob survives (evidence-based only)", () => {
  assert.equal(RTC_RESTART.giveUpRearmAfterMs, undefined,
    "a timer-based re-arm would re-spam the DO on every long app switch");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
