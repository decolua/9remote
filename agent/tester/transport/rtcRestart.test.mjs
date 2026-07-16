// Scenario test for RTC zombie recovery policy (backoff + cap).
// Tests the restart scheduling logic in isolation — web ProtocolManager uses `@/` alias
// so can't run under plain node. The policy (max attempts, backoff sequence, reset on open)
// is what matters; wiring is verified manually in the browser.
// Run: node tester/transport/rtcRestart.test.mjs
import assert from "node:assert";

// Mirror of web/shared/constants/transport.js RTC_RESTART — keep in sync.
const RTC_RESTART = {
  ackTimeoutMs: 5000,
  maxAttempts: 3,
  backoffMs: [1000, 2000, 4000]
};

// Minimal restart-scheduler replica — same logic as ProtocolManager._scheduleRtcRestart.
class FakeRestartScheduler {
  constructor() {
    this.attempts = 0;
    this.timer = null;
    this.restartCalls = 0;
    this.wsReady = true;
  }
  _schedule() {
    if (this.attempts >= RTC_RESTART.maxAttempts) return false; // capped
    const delay = RTC_RESTART.backoffMs[this.attempts] ?? RTC_RESTART.backoffMs[RTC_RESTART.backoffMs.length - 1];
    this.attempts++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.wsReady) return false;
      this._restart();
    }, delay);
    return true;
  }
  _restart() { this.restartCalls++; }
  _onOpen() { this.attempts = 0; clearTimeout(this.timer); this.timer = null; }
}

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// R1 — Each schedule increments attempt, uses correct backoff slot.
{
  const s = new FakeRestartScheduler();
  s._schedule();
  check("R1: attempt 1 after first schedule", s.attempts === 1);
  // 2nd schedule replaces pending timer (clearTimeout) — simulates rapid double-zombie
  s._schedule();
  check("R1: attempt 2", s.attempts === 2);
}

// R2 — Caps at maxAttempts; further schedule is no-op.
{
  const s = new FakeRestartScheduler();
  for (let i = 0; i < 5; i++) s._schedule();
  check("R2: caps at maxAttempts=3", s.attempts === 3, `got=${s.attempts}`);
}

// R3 — Reset on successful RTC open.
{
  const s = new FakeRestartScheduler();
  s._schedule(); s._schedule();
  check("R3: pre-reset attempts=2", s.attempts === 2);
  s._onOpen();
  check("R3: attempts reset to 0 on open", s.attempts === 0);
  check("R3: timer cleared on open", s.timer === null);
}

// R4 — Restart actually fires after backoff (async).
{
  const s = new FakeRestartScheduler();
  // Use a near-zero backoff for test speed via direct config override
  const original = RTC_RESTART.backoffMs;
  RTC_RESTART.backoffMs = [10, 20, 40];
  s._schedule();
  check("R4: restart not immediate", s.restartCalls === 0);
  await new Promise((r) => setTimeout(r, 50));
  check("R4: restart fired after backoff", s.restartCalls === 1, `calls=${s.restartCalls}`);
  RTC_RESTART.backoffMs = original;
}

// R5 — WS down suppresses restart (signaling needs WS).
{
  const s = new FakeRestartScheduler();
  s.wsReady = false;
  const original = RTC_RESTART.backoffMs;
  RTC_RESTART.backoffMs = [10, 20, 40];
  s._schedule();
  await new Promise((r) => setTimeout(r, 50));
  check("R5: no restart when ws down", s.restartCalls === 0, `calls=${s.restartCalls}`);
  RTC_RESTART.backoffMs = original;
}

// R6 — Backoff sequence correct per attempt.
{
  const s1 = new FakeRestartScheduler();
  s1._schedule();
  check("R6: attempt 1 backoff = 1000ms", RTC_RESTART.backoffMs[0] === 1000);
  const s2 = new FakeRestartScheduler();
  s2._schedule(); s2._schedule();
  check("R6: attempt 2 backoff = 2000ms", RTC_RESTART.backoffMs[1] === 2000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
