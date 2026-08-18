// Edge-liveness watchdog + background-loop coordination.
//
// Two failure modes this guards, both observed in production logs:
//
//  1. The watchdog killed the tunnel on a SINGLE failed probe, every 5s. A probe
//     fails on any DNS hiccup or slow response, and trycloudflare offers no uptime
//     guarantee, so a healthy tunnel was being killed several times an hour — each
//     kill rotating the URL and forcing every client to reconnect.
//
//  2. The background reconnect loop sits in a 1-15 minute backoff. It could not see
//     a tunnel that came up by another path meanwhile, so on its next wake it spawned
//     another cloudflared, whose startup kills the "stale" pid — the tunnel actually
//     serving traffic. Log evidence: "Tunnel restarted" at 19:19:13, then
//     "bg-tunnel attempt 2 error" at 19:20:12 killing it.
//
// Run: node agent/test/tunnelEdgeWatchdog.test.mjs
import assert from "node:assert/strict";

// Timestamps must be epoch-scale, as Date.now() gives in the real monitor: the
// counters start at 0, so a test clock starting at 0 would skip the first probe
// and shift every subsequent assertion by one interval.
const T0 = 1700000000000;

let pass = 0, fail = 0;
// Awaited so an async body's rejection is a failure — a sync runner would resolve
// the returned promise elsewhere and report every async test as passing.
const pending = [];
const test = (name, fn) => {
  const run = (async () => {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  })();
  pending.push(run);
};

// ── Watchdog: mirrors the streak logic in cli/utils/cloudflared.js ─────────
const EDGE_PROBE_INTERVAL_MS = 15000;
const EDGE_FAILURE_THRESHOLD = 3;
const TICK_MS = 5000;

function makeWatchdog() {
  return { probeAt: 0, streak: 0, kills: 0, probes: 0 };
}

// One monitor tick. probeOk === null means the probe was skipped this tick.
function tick(w, now, probeOk) {
  if (now - w.probeAt < EDGE_PROBE_INTERVAL_MS) return;
  w.probeAt = now;
  w.probes++;
  if (probeOk) { w.streak = 0; return; }
  if (++w.streak >= EDGE_FAILURE_THRESHOLD) { w.streak = 0; w.kills++; }
}

// The pre-fix behaviour, for comparison: probe every tick, kill on one failure.
function tickOld(w, now, probeOk) {
  w.probes++;
  if (!probeOk) w.kills++;
}

test("a single failed probe never kills the tunnel", () => {
  const w = makeWatchdog();
  tick(w, T0, false);
  assert.equal(w.kills, 0);
  assert.equal(w.streak, 1);
});

test("two failures then a success resets the streak", () => {
  const w = makeWatchdog();
  tick(w, T0, false);
  tick(w, T0 + 20000, false);
  tick(w, T0 + 40000, true);
  assert.equal(w.streak, 0);
  assert.equal(w.kills, 0);
});

test("a flapping edge (2 fail, 1 ok, repeating) is never killed", () => {
  const w = makeWatchdog();
  let now = T0;
  for (const ok of [false, false, true, false, false, true, false, false, true]) {
    tick(w, now, ok);
    now += EDGE_PROBE_INTERVAL_MS;
  }
  assert.equal(w.kills, 0);
});

test("a genuinely dead edge is still detected", () => {
  const w = makeWatchdog();
  let killedAt = null;
  for (let t = 0; t <= 120000; t += TICK_MS) {
    tick(w, T0 + t, false);
    if (w.kills && killedAt === null) killedAt = t;
  }
  assert.equal(w.kills >= 1, true, "must eventually restart");
  // Probes land at t=0, 15s, 30s — the third trips the threshold. Slower than the
  // old single-probe kill (~5s), which is the deliberate trade for not killing a
  // healthy tunnel; RTC keeps carrying traffic meanwhile.
  assert.equal(killedAt, 2 * EDGE_PROBE_INTERVAL_MS, "detected on the 3rd probe");
});

test("probes are throttled well below the tick rate", () => {
  const w = makeWatchdog();
  for (let t = 0; t < 3600000; t += TICK_MS) tick(w, T0 + t, true);
  const oldW = makeWatchdog();
  for (let t = 0; t < 3600000; t += TICK_MS) tickOld(oldW, T0 + t, true);
  assert.equal(oldW.probes, 720, "old: one probe per 5s tick");
  assert.ok(w.probes <= 241, `new should be ~240/h, got ${w.probes}`);
});

test("an unreliable network no longer causes kills", () => {
  // Deterministic 1-in-10 failure pattern — far worse than a real link.
  const isFail = (n) => n % 10 === 0;
  const w = makeWatchdog();
  const oldW = makeWatchdog();
  let n = 0;
  for (let t = 0; t < 3600000; t += TICK_MS) {
    n++;
    tick(w, T0 + t, !isFail(n));
    tickOld(oldW, T0 + t, !isFail(n));
  }
  assert.ok(oldW.kills > 0, "old behaviour killed on isolated failures");
  assert.equal(w.kills, 0, "isolated failures must never kill");
});

test("a fresh tunnel does not inherit the previous streak", () => {
  const w = makeWatchdog();
  tick(w, T0, false);
  tick(w, T0 + 20000, false);
  assert.equal(w.streak, 2);
  // spawnQuickTunnel / URL rotation resets both counters
  w.streak = 0; w.probeAt = 0;
  tick(w, T0 + 40000, false);
  assert.equal(w.kills, 0, "first miss on a new tunnel must not kill it");
});

// ── /ready gate: cloudflared's own verdict overrides our external probe ────
// Mirrors the final check in cli/utils/cloudflared.js before a kill. cloudflared
// keeps up to 4 edge connections and repairs them itself, so while it still holds
// one the fault is on the path to us — restarting would rotate the URL for nothing.
const shouldKill = (readyConns) => !(readyConns > 0);

test("a healthy cloudflared is never killed, however bad our probe looks", () => {
  assert.equal(shouldKill(4), false);
  assert.equal(shouldKill(1), false, "even a single edge connection still serves");
});

test("no edge connections means the tunnel really is dead", () => {
  assert.equal(shouldKill(0), true);
});

test("an unreachable metrics endpoint falls back to the probe verdict", () => {
  // Older cloudflared, port taken, or metrics not up yet — must not silently
  // disable the watchdog, so an unknown answer keeps the pre-/ready behaviour.
  assert.equal(shouldKill(null), true);
});

// ── Metrics port discovery must identify OUR tunnel ───────────────────────
// The ports are shared by every cloudflared on the machine, so a cached port can
// end up serving a different tunnel after a respawn. Trusting it reports healthy
// while our tunnel is dead — the exact case a restart exists for.
function makeReadyLookup(world) {
  const PORTS = [20241, 20242, 20243, 20244, 20245];
  let metricsPort = null;
  const on = (port, activeUrl) => {
    const entry = world[port];
    if (!entry) return null;
    if (entry.host && activeUrl && !activeUrl.includes(entry.host)) return null;
    return entry.readyConnections;
  };
  return {
    setPort: (p) => { metricsPort = p; },
    getPort: () => metricsPort,
    query(activeUrl) {
      if (metricsPort !== null) {
        const conns = on(metricsPort, activeUrl);
        if (conns !== null) return conns;
        metricsPort = null;
      }
      // Mirrors the parallel sweep in cloudflared.js: first port that identifies
      // as ours wins, scanned in list order.
      const hit = PORTS.map((port) => ({ port, conns: on(port, activeUrl) }))
        .find((r) => r.conns !== null);
      if (!hit) return null;
      metricsPort = hit.port;
      return hit.conns;
    },
  };
}

test("a cached port now serving another tunnel is rejected", () => {
  const lookup = makeReadyLookup({
    20241: { readyConnections: 4, host: "other.trycloudflare.com" },
  });
  lookup.setPort(20241);
  assert.equal(lookup.query("https://ours.trycloudflare.com"), null,
    "a stranger's healthy tunnel must not vouch for ours");
});

test("rediscovery finds our tunnel when it moved to another port", () => {
  const lookup = makeReadyLookup({
    20241: { readyConnections: 4, host: "other.trycloudflare.com" },
    20243: { readyConnections: 2, host: "ours.trycloudflare.com" },
  });
  lookup.setPort(20241);
  assert.equal(lookup.query("https://ours.trycloudflare.com"), 2);
  assert.equal(lookup.getPort(), 20243);
});

test("the port sweep costs one timeout, not five", async () => {
  // The monitor tick fires every 5s. Probing five ports in sequence, each waiting
  // out its timeout, would outlast the tick and stack them up.
  const TIMEOUT_MS = 60;
  const probe = async () => { await new Promise((r) => setTimeout(r, TIMEOUT_MS)); return null; };
  const t0 = Date.now();
  await Promise.all([20241, 20242, 20243, 20244, 20245].map(probe));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < TIMEOUT_MS * 3, `parallel sweep took ${elapsed}ms, expected ~${TIMEOUT_MS}ms`);
});

test("a metrics server with no hostname is still trusted", () => {
  // Named tunnels and older builds do not expose /quicktunnel; absence is not
  // evidence of a mismatch, so it must not disable the check entirely.
  const lookup = makeReadyLookup({ 20241: { readyConnections: 3, host: null } });
  assert.equal(lookup.query("https://ours.trycloudflare.com"), 3);
});

// ── hasLiveTunnel(): guards the background loop ───────────────────────────
// Mirrors cli/utils/cloudflared.js — url AND a pid that is actually alive.
const hasLiveTunnel = (url, pid, alive) => !!url && !!pid && alive;

test("hasLiveTunnel is false right after killCloudflared", () => {
  // killCloudflared clears the pid file but leaves activeTunnelUrl set, so a
  // url-only check would report a live tunnel that no longer exists.
  assert.equal(hasLiveTunnel("https://x.trycloudflare.com", null, false), false);
});

test("hasLiveTunnel is false when the process died unexpectedly", () => {
  assert.equal(hasLiveTunnel("https://x.trycloudflare.com", 123, false), false);
});

test("hasLiveTunnel is true only for a running tunnel with a url", () => {
  assert.equal(hasLiveTunnel("https://x.trycloudflare.com", 123, true), true);
  assert.equal(hasLiveTunnel(null, 123, true), false);
});

// ── Background loop vs restart handler ────────────────────────────────────
function simulate({ cancelOnRestart, checkBeforeSpawn }) {
  const state = { live: null, killed: [] };
  const ctx = { cancelled: false };
  const spawn = (who) => {
    if (state.live) state.killed.push(state.live); // startup kills the stale pid
    state.live = who;
  };

  spawn("restart");                       // restart handler wins
  if (cancelOnRestart) ctx.cancelled = true;

  // background loop wakes from its backoff
  if (!ctx.cancelled) {
    if (!(checkBeforeSpawn && state.live)) spawn("bg");
  }
  return state;
}

test("without the fix, the bg loop kills a working tunnel", () => {
  const s = simulate({ cancelOnRestart: false, checkBeforeSpawn: false });
  assert.deepEqual(s.killed, ["restart"], "reproduces the logged failure");
});

test("cancelling on restart success stops the bg loop", () => {
  const s = simulate({ cancelOnRestart: true, checkBeforeSpawn: false });
  assert.deepEqual(s.killed, []);
  assert.equal(s.live, "restart");
});

test("the live-tunnel check alone also prevents the kill", () => {
  // Belt and braces: cancel can be missed if the loop was armed after the
  // restart, so the pre-spawn check must hold on its own.
  const s = simulate({ cancelOnRestart: false, checkBeforeSpawn: true });
  assert.deepEqual(s.killed, []);
  assert.equal(s.live, "restart");
});

test("the bg loop still spawns when no tunnel is live", () => {
  const state = { live: null };
  const ctx = { cancelled: false };
  if (!ctx.cancelled && !state.live) state.live = "bg";
  assert.equal(state.live, "bg", "recovery must not be blocked");
});

await Promise.all(pending);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
