// E2E flow test for the mobile video pump: real setupMobileHandlers + pump,
// synthetic ScrcpySession (no adb), fake ordered channel with latency+bandwidth,
// fake client that reassembles and acks like useMobileStream.
//
// Regression: FLOW.ackWindow=4 capped throughput at 4 frames/RTT (~16fps on a
// 250ms tunnel) and tripped ADAPT restarts. The fps asserts sit above that old
// ceiling, so reverting the window fails this test.
// Run: node agent/test/mobileStreamFlow.test.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setupMobileHandlers } from "../features/mobile/mobileSocket.js";
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
    this._pts += 33333n;
    return { data: f.data, pts: this._pts, isConfig: !!f.isConfig, isKey: !!f.isKey };
  };
  ScrcpySession.prototype.requestKeyframe = function () {};
}
function restoreSession() {
  Object.assign(ScrcpySession.prototype, origProto);
}

// ---- fake bus + ordered channel with shared capacity + one-way latency ----
function makeHarness({ oneWayMs, bytesPerMs, refuseMobile }) {
  const handlers = new Map();
  const controlEvents = [];
  const sendStamps = new Map();   // seq → ts of its first chunk
  const arrived = [];             // { seq, ts, latencyMs }
  const pending = new Map();      // client reassembly, like useMobileStream
  const inflightSamples = [];
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
    const ready = Math.max(lastReady, now) + buf.byteLength / bytesPerMs;
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
    socket: {
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
async function runScenario(name, link, { frameBytes, count, minFps, capMs }) {
  const frames = [
    { data: Buffer.alloc(64, 0x67), isConfig: true },
    { data: Buffer.alloc(frameBytes * 2, 0x65), isKey: true },
    ...Array.from({ length: count }, (_, i) => ({ data: Buffer.alloc(frameBytes, i & 0xff), isKey: i % 30 === 0 }))
  ];

  const h = makeHarness(link);
  patchSession();
  currentScript = frames;
  try {
    setupMobileHandlers(h.socket);
    const res = await h.call("mobile:start", { serial: "synthetic-0", options: { maxSize: 720, bitRate: 4_000_000, maxFps: 30 } });
    assert.equal(res.success, true, `start failed: ${res.error}`);
    await h.waitDelivered(frames.length, capMs);
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

  // E2E correctness: every frame arrived, contiguous, byte-identical
  assert.equal(h.arrived.length, frames.length, `delivered ${h.arrived.length}/${frames.length}`);
  h.arrived.forEach((f, i) => {
    assert.equal(f.seq, i, `frames must arrive contiguous (got seq ${f.seq} at ${i})`);
    assert.ok(f.payload.equals(frames[i].data), `frame ${i} corrupted in transit`);
  });
  // Flow invariants: window respected, no ADAPT restart, one session
  assert.ok(Math.max(...h.inflightSamples) <= FLOW.ackWindow, `in-flight ${Math.max(...h.inflightSamples)} exceeded window ${FLOW.ackWindow}`);
  assert.equal(h.controlEvents.filter((e) => e.event === "mobile:resized").length, 0, "ADAPT restarted mid-run");
  assert.equal(startCalls, 1, "session restarted");
  // The regression assert: above the old window-4 ceiling
  assert.ok(fps >= minFps, `${fps.toFixed(1)} fps < required ${minFps} (window-4 ceiling was ${oldCapFps.toFixed(1)})`);
  // Video must ride its own lane, not the file-transfer lane
  const lanes = [...new Set(h.laneBySeq.values())];
  const refuseMobile = Boolean(link.refuseMobile);
  assert.deepEqual(lanes, [refuseMobile ? "file" : "mobile"],
    `video lane(s): ${lanes.join(",")} — expected ${link.refuseMobile ? "file (fallback)" : "mobile"}`);
}

console.log("\nmobile stream flow (pump + fake link + fake client)");

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
