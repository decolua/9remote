// E2E flow test for the mobile video pump: real setupMobileHandlers + pump,
// synthetic ScrcpySession (no adb), fake ordered channel with latency+bandwidth,
// fake client that reassembles and acks like useMobileStream.
//
// Regression: FLOW.ackWindow=4 capped throughput at 4 frames/RTT (~16fps on a
// 250ms tunnel) and tripped ADAPT restarts. The fps asserts sit above that old
// ceiling, so reverting the window fails this test.
// Run: node agent/test/mobileStreamFlow.test.mjs            (tests only)
//      node agent/test/mobileStreamFlow.test.mjs --bench    (link sweep table)
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setupMobileHandlers } from "../features/mobile/mobileBus.js";
import { ScrcpySession } from "../features/mobile/scrcpySession.js";
import { decodeMobileFrame } from "../features/mobile/mobileFrame.js";
import { FLOW } from "../features/mobile/constants.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ---- synthetic session: deterministic frames, no adb ----
const origProto = {
  start: ScrcpySession.prototype.start,
  readFrame: ScrcpySession.prototype.readFrame,
  requestKeyframe: ScrcpySession.prototype.requestKeyframe
};
let startCalls = 0;
let currentScript = [];
// Producer pacing: a real encoder emits ~30-60fps; an instant script would let
// drop-mode drain the whole backlog in one spin and end the stream.
let scriptGapMs = 16;
function patchSession() {
  startCalls = 0;
  ScrcpySession.prototype.start = async function () {
    startCalls++;
    this.screen = { width: 720, height: 1600 };
    this._script = [...currentScript]; // serve a copy — shift must not drain the source
    this._pts = 0n;
    return this.meta = { deviceName: "synthetic", codec: "h264", width: 720, height: 1600, screenWidth: 1080, screenHeight: 2400 };
  };
  ScrcpySession.prototype.readFrame = async function () {
    const f = this._script?.shift();
    if (!f) return null;
    await new Promise((r) => setTimeout(r, scriptGapMs));
    this._pts += 33333n;
    return { data: f.data, pts: this._pts, isConfig: !!f.isConfig, isKey: !!f.isKey };
  };
  ScrcpySession.prototype.requestKeyframe = function () {};
}
function restoreSession() {
  Object.assign(ScrcpySession.prototype, origProto);
}

// ---- fake bus + ordered channel with shared capacity + one-way latency ----
// Seeded PRNG so jittered runs are reproducible in CI (mulberry32, 4 lines).
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeHarness({ oneWayMs, bytesPerMs, refuseMobile, jitterMs = 0, seed = 42 }) {
  const handlers = new Map();
  const controlEvents = [];
  const sendStamps = new Map();   // seq → ts of its first chunk
  const arrived = [];             // { seq, ts, latencyMs }
  const pending = new Map();      // client reassembly, like useMobileStream
  const inflightSamples = [];
  const rand = mulberry32(seed);
  let lastAcked = -1;
  let lastReady = 0;

  const laneBySeq = new Map(); // seq → lane the first chunk actually took
  const sendBinary = (lane, buf) => {
    if (refuseMobile && lane === "mobile") return false;
    const chunk = decodeMobileFrame(buf);
    if (chunk && chunk.chunkIdx === 0) {
      laneBySeq.set(chunk.frameSeq, lane);
      sendStamps.set(chunk.frameSeq, performance.now());
      inflightSamples.push(chunk.frameSeq - lastAcked);
    }
    const now = performance.now();
    // Jitter delays a chunk's ENTRY to the FIFO (head-of-line, like an ordered
    // link): per-chunk post-queue jitter would reorder chunks, which TCP/SCTP
    // never do — the ordering invariants below depend on that.
    const enter = now + (jitterMs ? rand() * jitterMs : 0);
    const ready = Math.max(lastReady, enter) + buf.byteLength / bytesPerMs;
    lastReady = ready; // FIFO: later chunks can never overtake earlier ones
    setTimeout(() => arrive(chunk, performance.now()), ready - now + oneWayMs);
    return true;
  };

  const arrive = (chunk, ts) => {
    if (!chunk) return;
    let entry = pending.get(chunk.frameSeq);
    if (!entry) {
      entry = { chunks: new Array(chunk.chunkCount), received: 0 };
      pending.set(chunk.frameSeq, entry);
    }
    entry.chunks[chunk.chunkIdx] = chunk.payload;
    if (++entry.received !== chunk.chunkCount) return;
    pending.delete(chunk.frameSeq);
    arrived.push({
      seq: chunk.frameSeq,
      ts,
      isKey: chunk.isKey,
      latencyMs: ts - sendStamps.get(chunk.frameSeq),
      payload: Buffer.concat(entry.chunks.map(Buffer.from))
    });
    // client acks after the return half of the RTT
    setTimeout(() => {
      lastAcked = Math.max(lastAcked, chunk.frameSeq);
      handlers.get("mobile:ack")?.({ seq: chunk.frameSeq });
    }, oneWayMs);
  };

  return {
    bus: {
      data: { protocol: { sendBinary, emit: (event, data) => controlEvents.push({ event, data }) } },
      on: (ev, fn) => handlers.set(ev, fn)
    },
    controlEvents,
    arrived,
    inflightSamples,
    sendStamps,
    laneBySeq,
    call: (ev, data) => new Promise((res) => handlers.get(ev)(data, res)),
    // Wait for DELIVERY, not the agent's mobile:ended: chunks can still be in
    // flight inside the fake channel when the agent-side script has drained.
    waitDelivered: (expected, capMs) => new Promise((res) => {
      const t0 = performance.now();
      const poll = () => {
        if (arrived.length >= expected || performance.now() - t0 > capMs) return res();
        setTimeout(poll, 20);
      };
      poll();
    })
  };
}

// ---- scenario runner: stream frames, then assert + benchmark ----
// bench:true runs for MEASUREMENT: correctness invariants (order, gap→key,
// content) still assert, but fps/latency/drop expectations are skipped and the
// metrics row is returned for the sweep table.
async function runScenario(name, link, { frameBytes, count, minFps, capMs, keyEvery = 30, expectAll = true, maxLatP95 = Infinity, bench = false }) {
  const frames = [
    { data: Buffer.alloc(64, 0x67), isConfig: true },
    { data: Buffer.alloc(frameBytes * 2, 0x65), isKey: true },
    ...Array.from({ length: count }, (_, i) => ({ data: Buffer.alloc(frameBytes, i & 0xff), isKey: i % keyEvery === 0 }))
  ];

  const h = makeHarness(link);
  patchSession();
  currentScript = frames;
  try {
    setupMobileHandlers(h.bus);
    const res = await h.call("mobile:start", { serial: "synthetic-0", options: { maxSize: 720, bitRate: 4_000_000, maxFps: 30 } });
    assert.equal(res.success, true, `start failed: ${res.error}`);
    await h.waitDelivered(expectAll || bench ? frames.length : Math.floor(frames.length / 2), capMs);
    await new Promise((r) => setTimeout(r, 300)); // let late arrivals land before asserting
  } finally {
    restoreSession();
  }

  // Benchmark table
  const sortedLat = h.arrived.map((f) => f.latencyMs).sort((a, b) => a - b);
  const span = (h.arrived[h.arrived.length - 1].ts - h.sendStamps.get(0)) / 1000;
  const fps = h.arrived.length / span;
  const pct = (p) => sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * p))];
  const oldCapFps = 4 / Math.max(2 * link.oneWayMs, (4 * frameBytes) / link.bytesPerMs) * 1000;
  console.log(`  ${name}: ${h.arrived.length} frames, ${fps.toFixed(1)} fps (window-4 ceiling: ${oldCapFps.toFixed(1)}), lat p50 ${pct(0.5).toFixed(0)}ms p95 ${pct(0.95).toFixed(0)}ms`);

  if (expectAll) {
    // E2E correctness: every frame arrived, contiguous, byte-identical
    assert.equal(h.arrived.length, frames.length, `delivered ${h.arrived.length}/${frames.length}`);
    h.arrived.forEach((f, i) => {
      assert.equal(f.seq, i, `frames must arrive contiguous (got seq ${f.seq} at ${i})`);
      assert.ok(f.payload.equals(frames[i].data), `frame ${i} corrupted in transit`);
    });
  } else {
    // Congested link: frames are DROPPED, never queued stale. What arrives must
    // be in order, byte-identical to a script frame (drops desync seq from the
    // script index, so match by content — every script frame has a unique fill
    // byte), and every frame after a gap must be a keyframe — deltas whose
    // predecessors were dropped are undecodable.
    const scriptByFill = new Map(frames.map((f) => [f.data[0], f]));
    assert.equal(scriptByFill.size, frames.length, "test bug: script fills must be unique");
    if (!bench) assert.ok(h.arrived.length < frames.length, `expected drops under congestion, got all ${h.arrived.length}`);
    let prevSeq = -1;
    h.arrived.forEach((f) => {
      assert.ok(f.seq > prevSeq, `out-of-order delivery: seq ${f.seq} after ${prevSeq}`);
      if (prevSeq !== -1 && f.seq !== prevSeq + 1) {
        assert.ok(f.isKey, `seq ${f.seq} follows a gap (after ${prevSeq}) but is not a keyframe`);
      }
      assert.ok(f.payload.equals(scriptByFill.get(f.payload[0])?.data), `frame ${f.seq} corrupted in transit`);
      prevSeq = f.seq;
    });
    assert.ok(pct(0.95) <= maxLatP95, `p95 latency ${pct(0.95).toFixed(0)}ms > ${maxLatP95}ms — frames queued stale instead of dropped`);
    // Kick-on-slow-acks is a liveness contract, owned by the FrameFlow unit
    // tests (dead = sustained ack silence, never frame timeouts).
  }
  if (bench) {
    return { fps, p50: pct(0.5), p95: pct(0.95), delivered: h.arrived.length, total: frames.length,
      dropPct: Math.round((1 - h.arrived.length / frames.length) * 100) };
  }
  // Flow invariants: window respected, no ADAPT restart, one session
  assert.ok(Math.max(...h.inflightSamples) <= FLOW.ackWindow, `in-flight ${Math.max(...h.inflightSamples)} exceeded window ${FLOW.ackWindow}`);
  assert.equal(h.controlEvents.filter((e) => e.event === "mobile:resized").length, 0, "ADAPT restarted mid-run");
  assert.equal(startCalls, 1, "session restarted");
  // The regression assert: above the old window-4 ceiling
  if (!bench) assert.ok(fps >= minFps, `${fps.toFixed(1)} fps < required ${minFps} (window-4 ceiling was ${oldCapFps.toFixed(1)})`);
  // Video must ride its own lane, not the file-transfer lane
  const lanes = [...new Set(h.laneBySeq.values())];
  const refuseMobile = Boolean(link.refuseMobile);
  assert.deepEqual(lanes, [refuseMobile ? "file" : "mobile"],
    `video lane(s): ${lanes.join(",")} — expected ${link.refuseMobile ? "file (fallback)" : "mobile"}`);
}

console.log("\nmobile stream flow (pump + fake link + fake client)");

const BENCH = process.argv.includes("--bench");

if (!BENCH) {
  await test("LAN-like link sustains high fps", () =>
    runScenario("lan     rtt40  5MB/s", { oneWayMs: 20, bytesPerMs: 5 * 1024 * 1024 / 1000 },
      { frameBytes: 20 * 1024, count: 60, minFps: 50, capMs: 6000 }));

  await test("tunnel link (rtt 250ms, 1MB/s) beats the window-4 ceiling", () =>
    runScenario("tunnel  rtt250 1MB/s", { oneWayMs: 125, bytesPerMs: 1024 * 1024 / 1000 },
      { frameBytes: 30 * 1024, count: 80, minFps: 22, capMs: 9000 }));

  await test("slow tunnel (rtt 400ms, 0.5MB/s) still streams", () =>
    runScenario("slow    rtt400 .5MB/s", { oneWayMs: 200, bytesPerMs: 512 * 1024 / 1000 },
      { frameBytes: 24 * 1024, count: 40, minFps: 14, capMs: 9000 }));

  await test("old peer without the mobile DC falls back to the file lane", () =>
    runScenario("fallback rtt250 1MB/s", { oneWayMs: 125, bytesPerMs: 1024 * 1024 / 1000, refuseMobile: true },
      { frameBytes: 30 * 1024, count: 40, minFps: 22, capMs: 9000 }));
}

// The WS-fallback complaint: RTC smooth, WS very slow AND kicked. A jammed link
// (rtt 800ms, 0.2MB/s) must drop stale frames and resume on keyframes —
// bounded latency, no unbounded queue, and never a "viewer gone" kill while
// acks keep trickling back.
if (!BENCH) await test("jammed link drops stale frames instead of stacking latency or getting kicked", () =>
  runScenario("jammed  rtt800 .2MB/s", { oneWayMs: 400, bytesPerMs: 200 * 1024 / 1000 },
    { frameBytes: 30 * 1024, count: 60, keyEvery: 6, minFps: 2, capMs: 9000, expectAll: false, maxLatP95: 4000 }));

// The fake harness bypasses ProtocolManager, so routing must be checked against
// the real statics: a lane missing from capabilities/profiles silently degrades
// every frame to the file lane (the bug this section exists to catch).
await test("adapters and profiles declare the mobile lane", async () => {
  const [{ WebRtcProtocol: Rtc, WsProtocol: Ws }, { CHANNELS, TRANSPORT_PROFILES }] = await Promise.all([
    import("../transport/WebRtcProtocol.js"),
    import("../lib/transportConstants.js")
  ]);
  const wsMod = await import("../transport/WsProtocol.js");
  for (const A of [Rtc, wsMod.WsProtocol]) {
    assert.ok(A.capabilities[CHANNELS.mobile], `${A.id} capabilities must include mobile`);
    assert.ok(A.priority[CHANNELS.mobile] !== undefined, `${A.id} priority must include mobile`);
  }
  for (const [name, prof] of Object.entries(TRANSPORT_PROFILES)) {
    assert.ok(prof.channels[CHANNELS.mobile], `profile "${name}" must route the mobile lane`);
  }
});

// ---- benchmark sweep: fps / latency / drop-rate across the link matrix ----
// Same pump, same fake channel, correctness invariants still asserted — only
// the pass/fail floors are dropped so every link reports its numbers. Use this
// to re-tune FLOW.stallMs / maxInFlightBytes against the matrix instead of
// guessing. count stays < 101: the delta fill byte (i & 0xff) must not collide
// with the config (0x67) / first-key (0x65) fills the content check maps on.
if (BENCH) {
  console.log("\nbenchmark sweep (FLOW tunables under varying links)");
  const MB = 1024 * 1024 / 1000;
  const LINKS = [
    ["lan      rtt40   5MB/s", { oneWayMs: 20, bytesPerMs: 5 * MB }],
    ["wifi     rtt80   2MB/s", { oneWayMs: 40, bytesPerMs: 2 * MB }],
    ["tunnel   rtt150  1MB/s", { oneWayMs: 75, bytesPerMs: 1 * MB }],
    ["tunnel   rtt250  1MB/s jit60", { oneWayMs: 125, bytesPerMs: 1 * MB, jitterMs: 60 }],
    ["tunnel   rtt250  0.5MB/s", { oneWayMs: 125, bytesPerMs: 0.5 * MB }],
    ["slow     rtt400  0.5MB/s", { oneWayMs: 200, bytesPerMs: 0.5 * MB }],
    ["bad3g    rtt600  0.3MB/s jit150", { oneWayMs: 300, bytesPerMs: 0.3 * MB, jitterMs: 150 }],
    ["jammed   rtt800  0.2MB/s", { oneWayMs: 400, bytesPerMs: 0.2 * MB }]
  ];
  const rows = [];
  for (const [name, link] of LINKS) {
    try {
      rows.push({ name, ...await runScenario(name, link,
        { frameBytes: 24 * 1024, count: 90, keyEvery: 15, capMs: 6000, expectAll: false, bench: true }) });
    } catch (e) {
      fail++; console.error(`  ✗ ${name}: ${e.message}`);
    }
  }
  console.log("\n  link                        fps     p50      p95    delivered   dropped");
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(26)} ${r.fps.toFixed(1).padStart(5)}  ${Math.round(r.p50).toString().padStart(4)}ms  ${Math.round(r.p95).toString().padStart(5)}ms  ` +
      `${(r.delivered + "/" + r.total).padStart(9)}  ${r.dropPct.toString().padStart(5)}%`
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
