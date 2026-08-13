// Tests for the gap-recovery handshake (plan G) in useXTerm's output handler.
// Replicates its state machine verbatim — the React/xterm parts are stubbed —
// and attacks the ordering races that would silently LOSE terminal output:
//   • the ack arriving before its own chunks (they travel different carriers)
//   • chunks arriving before the ack
//   • a stale chunk landing after a fallback already reset the terminal
//
// Run: node web/test/gapRecovery.test.mjs
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Mirror of the useXTerm gap state machine.
function createGapMachine({ fromSeq, toSeq, firstChunk }) {
  const painted = [];      // what reached the terminal, in order
  const events = [];       // "recovered" | "reset"
  let lastSeq = fromSeq - 1;
  const state = {
    pending: [firstChunk], fromSeq, toSeq,
    settled: false, timer: "armed", expected: null, received: 0,
    seen: new Set(),
  };
  let ref = state;

  state.finish = () => {
    if (state.settled || ref !== state) return; // cancelled by reconnect/unmount
    state.settled = true;
    state.timer = null;
    for (const p of state.pending) {
      painted.push(p.data);
      if (p.seq != null) lastSeq = p.seq;
    }
    ref = null;
    events.push("recovered");
  };
  const fallback = (why) => {
    if (state.settled || ref !== state) return; // cancelled by reconnect/unmount
    state.settled = true;
    state.timer = null;
    ref = null;
    events.push(`reset:${why}`);
  };

  return {
    painted, events, state,
    get lastSeq() { return lastSeq; },
    get active() { return ref === state; },
    // A gap chunk arrives from the agent.
    gapChunk(seq, data) {
      if (!ref || seq == null) return "rejected";
      if (seq < ref.fromSeq || seq > ref.toSeq) return "rejected";
      if (ref.seen.has(seq)) return "duplicate"; // retransmit — already painted
      painted.push(data);
      lastSeq = seq;
      ref.seen.add(seq);
      state.received = ref.seen.size;
      if (state.expected != null && state.received >= state.expected) state.finish();
      return "painted";
    },
    // Live output while the fetch is in flight.
    liveChunk(seq, data) {
      if (!ref) return "not-queued";
      ref.pending.push({ data, seq });
      return "queued";
    },
    ack(res) {
      if (state.settled || ref !== state) return; // cancelled meanwhile
      if (!res?.hit) return fallback("miss");
      state.expected = res.count ?? 0;
      if (state.received >= state.expected) state.finish();
    },
    fireTimeout() { fallback("timeout"); },
    // resetReconnectState / unmount nulls the ref without settling the state.
    cancel() { ref = null; },
  };
}

const first = { data: "live-8", seq: 8 };

// ── Ordering: chunks first, then ack ───────────────────────────────────────

test("chunks then ack → content in order [gap…, queued live], one recovery", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.gapChunk(6, "gap-6");
  m.gapChunk(7, "gap-7");
  m.ack({ hit: true, count: 2 });
  assert.deepEqual(m.painted, ["gap-6", "gap-7", "live-8"]);
  assert.deepEqual(m.events, ["recovered"]);
  assert.equal(m.lastSeq, 8);
});

// ── Ordering: ack first (the bug this fixes) ───────────────────────────────

test("ack BEFORE its chunks → still waits, no content lost", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.ack({ hit: true, count: 2 });          // ack raced ahead over the other carrier
  assert.deepEqual(m.events, [], "must not finish before the chunks land");
  assert.equal(m.active, true, "gap window must stay open");
  assert.equal(m.gapChunk(6, "gap-6"), "painted");
  assert.equal(m.gapChunk(7, "gap-7"), "painted");
  assert.deepEqual(m.painted, ["gap-6", "gap-7", "live-8"]);
  assert.deepEqual(m.events, ["recovered"]);
});

test("ack first then a PARTIAL delivery → timeout falls back, never a silent hole", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.ack({ hit: true, count: 2 });
  m.gapChunk(6, "gap-6");                  // second chunk never arrives
  assert.deepEqual(m.events, []);
  m.fireTimeout();
  assert.deepEqual(m.events, ["reset:timeout"]);
});

test("interleaved ack between chunks completes exactly once", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 8, firstChunk: { data: "live-9", seq: 9 } });
  m.gapChunk(6, "gap-6");
  m.ack({ hit: true, count: 3 });
  m.gapChunk(7, "gap-7");
  m.gapChunk(8, "gap-8");
  assert.deepEqual(m.painted, ["gap-6", "gap-7", "gap-8", "live-9"]);
  assert.deepEqual(m.events, ["recovered"], "must recover once, not twice");
});

// ── Miss / fallback ────────────────────────────────────────────────────────

test("cache miss → reset+rejoin, queued live is dropped (the replay carries it)", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.ack({ hit: false });
  assert.deepEqual(m.events, ["reset:miss"]);
  assert.deepEqual(m.painted, [], "nothing painted — the rejoin repaints everything");
});

test("chunk arriving AFTER a fallback is rejected (would corrupt the fresh buffer)", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.fireTimeout();
  assert.equal(m.gapChunk(6, "late-gap-6"), "rejected");
  assert.deepEqual(m.painted, []);
  assert.deepEqual(m.events, ["reset:timeout"]);
});

test("ack arriving after a timeout is ignored (no double handling)", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.fireTimeout();
  m.ack({ hit: true, count: 2 });
  assert.deepEqual(m.events, ["reset:timeout"]);
});

test("timeout after a successful recovery does nothing", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 6, firstChunk: first });
  m.gapChunk(6, "gap-6");
  m.ack({ hit: true, count: 1 });
  m.fireTimeout();
  assert.deepEqual(m.events, ["recovered"], "already settled — timeout must be inert");
});

// ── Range guard ────────────────────────────────────────────────────────────

test("out-of-range gap chunks are rejected (stale fetch from a previous gap)", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  assert.equal(m.gapChunk(3, "too-old"), "rejected");
  assert.equal(m.gapChunk(99, "too-new"), "rejected");
  assert.deepEqual(m.painted, []);
});

// ── Live queueing during the window ────────────────────────────────────────

test("live output during the fetch is queued and flushed after the gap", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 6, firstChunk: first });
  m.liveChunk(9, "live-9");
  m.liveChunk(10, "live-10");
  m.gapChunk(6, "gap-6");
  m.ack({ hit: true, count: 1 });
  assert.deepEqual(m.painted, ["gap-6", "live-8", "live-9", "live-10"]);
  assert.equal(m.lastSeq, 10, "lastSeq must follow the newest flushed live chunk");
});

test("empty gap range (count 0) completes immediately on the ack", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 5, firstChunk: first });
  m.ack({ hit: true, count: 0 });
  assert.deepEqual(m.events, ["recovered"]);
  assert.deepEqual(m.painted, ["live-8"]);
});

// ── Duplicate delivery ─────────────────────────────────────────────────────

test("a retransmitted gap chunk is not painted twice", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.gapChunk(6, "gap-6");
  assert.equal(m.gapChunk(6, "gap-6"), "duplicate");
  m.gapChunk(7, "gap-7");
  m.ack({ hit: true, count: 2 });
  assert.deepEqual(m.painted, ["gap-6", "gap-7", "live-8"], "no doubled content");
});

test("duplicates never complete the set while a chunk is still missing", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.ack({ hit: true, count: 2 });
  m.gapChunk(6, "gap-6");
  m.gapChunk(6, "gap-6"); // retransmit — must NOT count toward the total
  assert.deepEqual(m.events, [], "still waiting for seq 7");
  m.gapChunk(7, "gap-7");
  assert.deepEqual(m.events, ["recovered"]);
});

test("a chunk with no seq is rejected (old agent sending gap without seq)", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  assert.equal(m.gapChunk(null, "no-seq"), "rejected");
  assert.deepEqual(m.painted, []);
});

// ── Cancellation (reconnect / unmount clears the ref mid-flight) ───────────

test("ack arriving after a reconnect cancelled the fetch paints nothing", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.cancel();                              // resetReconnectState nulled the ref
  m.ack({ hit: true, count: 2 });
  assert.deepEqual(m.events, [], "the rejoin owns the buffer — no second paint");
  assert.deepEqual(m.painted, []);
});

test("miss ack after cancellation does not fire a second reset+rejoin", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.cancel();
  m.ack({ hit: false });
  assert.deepEqual(m.events, [], "reconnect already scheduled its own rejoin");
});

test("timeout after cancellation is inert", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.cancel();
  m.fireTimeout();
  assert.deepEqual(m.events, []);
});

test("gap chunks after cancellation are rejected", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 7, firstChunk: first });
  m.cancel();
  assert.equal(m.gapChunk(6, "gap-6"), "rejected");
  assert.deepEqual(m.painted, []);
});

test("window closes after recovery so later live output renders normally", () => {
  const m = createGapMachine({ fromSeq: 6, toSeq: 6, firstChunk: first });
  m.gapChunk(6, "gap-6");
  m.ack({ hit: true, count: 1 });
  assert.equal(m.active, false);
  assert.equal(m.liveChunk(9, "live-9"), "not-queued", "must render inline, not queue");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
