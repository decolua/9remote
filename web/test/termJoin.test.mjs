// Characterization tests for termJoin + termOutputRouter extracted from useXTerm.
// Run: node --import ./test/loader-alias.mjs web/test/termJoin.test.mjs
import assert from "node:assert/strict";
import { createJoinSession } from "../features/terminal/lib/termJoin.js";
import { createOutputRouter } from "../features/terminal/lib/termOutputRouter.js";
import { useTerminalStore } from "../shared/stores/terminalStore.js";

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push(Promise.resolve().then(() => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}));
const spy = (impl) => {
  const fn = (...a) => { fn.calls.push(a); return fn.impl ? fn.impl(...a) : undefined; };
  fn.calls = []; fn.impl = impl; return fn;
};
const ref = (v) => ({ current: v });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTerm() {
  return {
    writes: [],
    write: spy((d, cb) => { this; }),
    reset: spy(),
    scrollLines: spy(),
    buffer: { active: { viewportY: 5, baseY: 100 } }
  };
}
// term.write needs to invoke its callback for replay assertions — wrap manually per test.

function makeRefs() {
  return {
    historyMirrorRef: ref([]), historyBytesRef: ref(0), historyTotalRef: ref(0),
    historyFetchingRef: ref(false), userAtTopRef: ref(false),
    joiningRef: ref(false), joinQueueRef: ref([]), joinGenRef: ref(0),
    lastSeqRef: ref(null), cwdRef: ref(null), setJoining: spy(),
    lastOutputAtRef: ref(0), outputTotalRef: ref(0), awaitingTuiOutputRef: ref(false),
    historyHaveAtEmitRef: ref(0)
  };
}

// ── termOutputRouter ──────────────────────────────────────────────────────────
function makeRouter(over = {}) {
  const term = makeTerm();
  const batcher = { write: spy(), flush: spy() };
  const writeBatcherRef = ref(batcher);
  const refs = makeRefs();
  const gapFetch = { handleGapChunk: spy(() => true), queueLive: spy(() => false), start: spy() };
  const setHistoryFetching = spy();
  const router = createOutputRouter({ sessionId: "s1", term, writeBatcherRef, gapFetch, refs, setHistoryFetching, ...over });
  return { term, batcher, writeBatcherRef, refs, gapFetch, setHistoryFetching, router };
}

test("router: ignores other sessions", () => {
  const { batcher, router } = makeRouter();
  router.handleOutput({ sessionId: "other", data: "x" });
  assert.equal(batcher.write.calls.length, 0);
});

test("router: b64 payload decoded to bytes before write", () => {
  const { batcher, refs, router } = makeRouter();
  router.handleOutput({ sessionId: "s1", data: "aGk=", enc: "b64" }); // "hi"
  const written = batcher.write.calls[0][0];
  assert.ok(written instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(written), "hi");
  assert.equal(refs.outputTotalRef.current, 4, "length counted pre-decode");
});

test("router: replay writes immediately (no mirror) and resyncs seq", () => {
  const { batcher, refs, router } = makeRouter();
  refs.lastSeqRef.current = 5;
  router.handleOutput({ sessionId: "s1", data: "tail", replay: true, seq: 42 });
  assert.deepEqual(batcher.write.calls[0], ["tail"]);
  assert.equal(batcher.flush.calls.length, 1);
  assert.equal(refs.historyMirrorRef.current.length, 0, "replay not mirrored");
  assert.equal(refs.lastSeqRef.current, 42);
});

test("router: gap chunk goes to gapFetch only", () => {
  const { batcher, gapFetch, router } = makeRouter();
  router.handleOutput({ sessionId: "s1", data: "g", gap: true, seq: 7 });
  assert.deepEqual(gapFetch.handleGapChunk.calls, [["g", 7]]);
  assert.equal(batcher.write.calls.length, 0);
});

test("router: live during join queues; during gap queues via gapFetch", () => {
  const { refs, gapFetch, batcher, router } = makeRouter();
  refs.joiningRef.current = true;
  router.handleOutput({ sessionId: "s1", data: "live1", seq: 3 });
  assert.deepEqual(refs.joinQueueRef.current, [{ data: "live1", seq: 3 }]);
  refs.joiningRef.current = false;
  gapFetch.queueLive = spy(() => true);
  router.handleOutput({ sessionId: "s1", data: "live2", seq: 4 });
  assert.deepEqual(gapFetch.queueLive.calls, [["live2", 4]]);
  assert.equal(batcher.write.calls.length, 0, "queued, not written");
});

test("router: seq gap triggers gapFetch.start; stale dropped; live advances lastSeq", () => {
  const { refs, gapFetch, batcher, router } = makeRouter();
  refs.lastSeqRef.current = 10;
  router.handleOutput({ sessionId: "s1", data: "future", seq: 12 });
  assert.deepEqual(gapFetch.start.calls, [[11, [{ data: "future", seq: 12 }]]]);
  // stale (seq behind lastSeq) → dropped entirely
  gapFetch.start.calls = [];
  router.handleOutput({ sessionId: "s1", data: "old", seq: 9 });
  assert.equal(gapFetch.start.calls.length, 0);
  assert.equal(batcher.write.calls.length, 0);
  // contiguous live (lastSeq+1) → written, lastSeq advanced, mirror counts bytes
  router.handleOutput({ sessionId: "s1", data: "ok", seq: 11 });
  assert.deepEqual(batcher.write.calls, [["ok"]]);
  assert.equal(refs.lastSeqRef.current, 11);
  assert.equal(refs.historyBytesRef.current, 2);
});

test("router: empty history prefix skips reset (no viewport yank)", () => {
  const { term, router, setHistoryFetching } = makeRouter();
  router.handleOutput({ sessionId: "s1", data: "", isHistoryPrefix: true });
  assert.equal(term.reset.calls.length, 0);
  assert.equal(setHistoryFetching.calls.at(-1)[0], false);
});

// ── termJoin ──────────────────────────────────────────────────────────────────
test("join: delegates size negotiation to doResize({join:true}) via rAF", async () => {
  const socket = { emit: spy() };
  const term = makeTerm();
  const fitAddon = { fit: spy() };
  const doResizeRef = ref(spy());
  const fireJoinRef = ref(null);
  const refs = makeRefs();
  const setCwd = spy();
  const doJoin = createJoinSession({ socket, sessionId: "s1", term, fitAddon, writeBatcherRef: ref(null), doResizeRef, fireJoinRef, refs, setCwd });
  doJoin();
  await sleep(5); // rAF stub → setTimeout in node
  assert.deepEqual(doResizeRef.current.calls, [[{ join: true }]]);
  assert.equal(typeof fireJoinRef.current, "function");
});

test("join: payload with size only when agent advertises joinSessionSize", async () => {
  const socket = { emit: spy((_ev, payload, ack) => { setTimeout(() => ack({ success: true, total: 99, seq: 5, cwd: "/x" }), 0); }) };
  const term = makeTerm();
  const refs = makeRefs();
  const doJoin = createJoinSession({ socket, sessionId: "s1", term, fitAddon: { fit: spy() }, writeBatcherRef: ref(null), doResizeRef: ref(spy()), fireJoinRef: ref(null), refs, setCwd: spy() });
  useTerminalStore.setState({ agentCaps: { joinSessionSize: true } });
  doJoin();
  const fireJoinRef = ref(null);
  const doJoin2 = createJoinSession({ socket, sessionId: "s1", term, fitAddon: { fit: spy() }, writeBatcherRef: ref(null), doResizeRef: ref(spy()), fireJoinRef, refs: makeRefs(), setCwd: spy() });
  doJoin2();
  fireJoinRef.current(80, 24);
  assert.deepEqual(socket.emit.calls[0][1], { sessionId: "s1", cols: 80, rows: 24 });
  await sleep(10);
  // no caps → bare sessionId string
  useTerminalStore.setState({ agentCaps: {} });
  const socket2 = { emit: spy((_e, _p, ack) => setTimeout(() => ack({ success: true }), 0)) };
  const fj2 = ref(null);
  const doJoin3 = createJoinSession({ socket: socket2, sessionId: "s1", term, fitAddon: { fit: spy() }, writeBatcherRef: ref(null), doResizeRef: ref(spy()), fireJoinRef: fj2, refs: makeRefs(), setCwd: spy() });
  doJoin3();
  fj2.current(80, 24);
  assert.equal(socket2.emit.calls[0][1], "s1");
});

test("join: ack flushes queued live in order and resyncs seq to max(ack, queueTail)", async () => {
  const socket = { emit: spy((_e, _p, ack) => setTimeout(() => ack({ success: true, seq: 10 }), 0)) };
  const term = makeTerm();
  const batcher = { write: spy(), flush: spy() };
  const refs = makeRefs();
  const fireJoinRef = ref(null);
  const doJoin = createJoinSession({ socket, sessionId: "s1", term, fitAddon: { fit: spy() }, writeBatcherRef: ref(batcher), doResizeRef: ref(spy()), fireJoinRef, refs, setCwd: spy() });
  doJoin();
  fireJoinRef.current(80, 24);
  refs.joiningRef.current = true; // as if live raced the join
  refs.joinQueueRef.current = [{ data: "a", seq: 11 }, { data: "b", seq: 12 }];
  await sleep(10);
  assert.deepEqual(batcher.write.calls, [["a"], ["b"]]);
  assert.equal(refs.lastSeqRef.current, 12, "queue tail 12 > ack 10");
  assert.equal(refs.joiningRef.current, false);
  assert.equal(refs.setJoining.calls.at(-1)[0], false);
});

test("join: failed ack writes error to term", async () => {
  const socket = { emit: spy((_e, _p, ack) => setTimeout(() => ack({ success: false, error: "boom" }), 0)) };
  const term = { ...makeTerm(), write: spy() };
  const refs = makeRefs();
  const fireJoinRef = ref(null);
  const doJoin = createJoinSession({ socket, sessionId: "s1", term, fitAddon: { fit: spy() }, writeBatcherRef: ref(null), doResizeRef: ref(spy()), fireJoinRef, refs, setCwd: spy() });
  doJoin();
  fireJoinRef.current(80, 24);
  await sleep(10);
  assert.match(term.write.calls[0][0], /boom/);
});

await Promise.all(tests);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
