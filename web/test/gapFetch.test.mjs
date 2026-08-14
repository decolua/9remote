// Characterization tests for the gap-fetch state machine extracted from useXTerm.
// Uses a fake socket + manual clock to drive the ack/timer races.
// Run: node --import ./test/loader-alias.mjs web/test/gapFetch.test.mjs
import assert from "node:assert/strict";
import { createGapFetch } from "../features/terminal/lib/gapFetch.js";

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push((async () => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
})());

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeGap({ lastSeq = 10, painted = [], fallbacks = 0 } = {}) {
  let lastSeqState = lastSeq;
  const state = { painted, emits: [], acks: [], timers: [] };
  const gf = createGapFetch({
    emit: (payload, ack) => { state.emits.push(payload); state.acks.push(ack); },
    writeChunk: (data) => painted.push(data),
    onGapChunk: (seq) => { lastSeqState = seq; },
    onFallback: () => { fallbacks++; },
    log: () => {},
    getFromSeq: () => lastSeqState + 1
  });
  return { gf, state, get lastSeq() { return lastSeqState; } };
}

// Drive the fake GAP_FETCH_TIMEOUT_MS deterministically: patch setTimeout for the fallback timer
const REAL_TIMEOUT = (await import("../features/terminal/constants/terminalConfig.js")).GAP_FETCH_TIMEOUT_MS;
assert.ok(REAL_TIMEOUT > 1000, "expected a real (large) GAP_FETCH_TIMEOUT_MS");

test("no-op when nothing missing (toSeq < fromSeq)", async () => {
  const { gf, state } = makeGap({ lastSeq: 10 });
  gf.start(5);
  assert.equal(state.emits.length, 0);
});

test("happy path: ack then chunks in order → flushed after last chunk, no fallback", async () => {
  const painted = [];
  const { gf, state } = makeGap({ lastSeq: 10, painted });
  gf.start(13);
  assert.deepEqual(state.emits[0], { fromSeq: 11, toSeq: 13 });
  state.acks[0]({ hit: true, count: 3 }); // ack first — must not finish early
  assert.deepEqual(painted, []);
  gf.handleGapChunk("a", 11);
  gf.handleGapChunk("b", 12);
  assert.deepEqual(painted, ["a", "b"]); // painted as they arrive
  gf.handleGapChunk("c", 13);
  await flush();
  assert.deepEqual(painted, ["a", "b", "c"]);
});

test("retransmit is dropped but distinct-count completion still works", async () => {
  const painted = [];
  const { gf, state } = makeGap({ lastSeq: 10, painted });
  gf.start(12);
  state.acks[0]({ hit: true, count: 2 });
  gf.handleGapChunk("a", 11);
  gf.handleGapChunk("a", 11); // duplicate delivery
  assert.deepEqual(painted, ["a"]);
  gf.handleGapChunk("b", 12);
  assert.deepEqual(painted, ["a", "b"]);
});

test("live output during fetch is queued and flushed after the gap", async () => {
  const painted = [];
  const { gf, state } = makeGap({ lastSeq: 10, painted });
  gf.start(12);
  assert.equal(gf.queueLive("live1", 13), true);
  state.acks[0]({ hit: true, count: 2 });
  gf.handleGapChunk("a", 11);
  gf.handleGapChunk("b", 12);
  assert.deepEqual(painted, ["a", "b", "live1"]); // order [gap … live]
  assert.equal(gf.queueLive("late", 14), false); // window closed
});

test("out-of-range and missing-seq chunks are ignored", async () => {
  const painted = [];
  const { gf, state } = makeGap({ lastSeq: 10, painted });
  gf.start(12);
  state.acks[0]({ hit: true, count: 2 });
  assert.equal(gf.handleGapChunk("old", 9), false); // below range
  assert.equal(gf.handleGapChunk("future", 20), false); // above range
  assert.equal(gf.handleGapChunk("noseq", null), false);
  assert.deepEqual(painted, []);
});

test("ring miss → fallback, later chunks rejected", async () => {
  const painted = [];
  let fallbacks = 0;
  const { gf, state } = makeGap({ lastSeq: 10, painted });
  gf.onFallbackCount = 0;
  const gf2 = createGapFetch({
    emit: (p, ack) => state.acks.push(ack),
    writeChunk: (d) => painted.push(d),
    onGapChunk: () => {},
    onFallback: () => { fallbacks++; },
    log: () => {},
    getFromSeq: () => 11
  });
  gf2.start(13);
  state.acks[0]({ hit: false });
  await flush();
  assert.equal(fallbacks, 1);
  assert.equal(gf2.handleGapChunk("late", 11), false); // guarded after fallback
});

test("only one fetch in flight at a time", async () => {
  const { gf, state } = makeGap({ lastSeq: 10 });
  gf.start(13);
  gf.start(20); // second call ignored
  assert.equal(state.emits.length, 1);
});

test("cancel suppresses the fallback timer and pending ack", async () => {
  let fallbacks = 0;
  const acks = [];
  const gf = createGapFetch({
    emit: (p, ack) => acks.push(ack), flush: () => {},
    writeChunk: () => {},
    onGapChunk: () => {},
    onFallback: () => { fallbacks++; },
    log: () => {},
    getFromSeq: () => 11
  });
  gf.start(13);
  gf.cancel();
  assert.equal(gf.isBusy(), false);
  acks[0]({ hit: true, count: 5 }); // late ack after cancel → no-op
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fallbacks, 0);
});

await Promise.all(tests);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
