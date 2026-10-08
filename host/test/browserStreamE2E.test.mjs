// E2E: real Chrome screencast → binary frame chunks at the transport edge.
// Exercises the exact path the pane uses: stream.start → CDP screencastFrame →
// handleFrame (ack window) → browserFrameChunks → sendBinary(file lane) →
// client ack releases the window. The only fake is the PM at the wire edge.
// Run: node test/browserStreamE2E.test.mjs (skips silently without Chrome)
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { decodeBrowserFrame } from "../features/browser/browserFrame.js";
import { closeTab, createProfile, getOrLaunchBrowser, openTab, removeProfile, resolveChromeBinary } from "../features/browser/browserEngine.js";
import { setupBrowserHandlers } from "../features/browser/browserSocket.js";
import { registerProtocol, unregisterProtocol } from "../transport/broadcast.js";
import { CHANNELS } from "../lib/transportConstants.js";

// Unique profile per run: the previous run's graceful Chrome close releases
// its profile lock async — a reused name races the singleton forward.
const TARGET = `e2e-stream-${Date.now().toString(36)}`;
const sentChunks = [];
const lanes = [];

// Fake PM at the wire edge: records every binary chunk by lane.
const fakePm = {
  _deviceId: `${TARGET}:1`,
  type: "ws",
  hasReadyAdapter: () => true,
  sendBinary: (channel, buf) => {
    sentChunks.push(buf);
    lanes.push(channel);
    return true;
  },
  emit: () => true
};

// Minimal socket: setupBrowserHandlers only needs .on + handler dispatch.
function makeSocket() {
  const handlers = new Map();
  return {
    id: "sock-e2e",
    connected: true,
    on: (ev, fn) => handlers.set(ev, fn),
    emitClient: (ev, data, cb) => handlers.get(ev)?.(data, cb)
  };
}

function collectFrames(ms = 4000) {
  const frames = new Map(); // seq → {got, count, parts, flags}
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      for (const buf of sentChunks) {
        const dec = decodeBrowserFrame(buf);
        if (!dec) continue;
        let entry = frames.get(dec.seq);
        if (!entry) { entry = { got: 0, count: dec.chunkCount, parts: [], flags: dec.flags }; frames.set(dec.seq, entry); }
        if (entry.parts[dec.chunkIdx]) continue;
        entry.parts[dec.chunkIdx] = dec.payload;
        entry.got++;
      }
      const done = [...frames.entries()].find(([, e]) => e.got === e.count);
      if (done || Date.now() > deadline) {
        clearInterval(tick);
        resolve(done ? { seq: done[0], entry: done[1] } : null);
      }
    }, 50);
  });
}

function joinedPayload(entry) {
  return Buffer.concat(entry.parts);
}

function tileCountOf(entry) {
  const buf = joinedPayload(entry);
  if (entry.flags !== 1) return -1;
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
}

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("real Chrome frames arrive as decodable binary chunks on the file lane", async () => {
  if (!resolveChromeBinary()) return;
  await createProfile(TARGET);
  registerProtocol(fakePm);
  const socket = makeSocket();
  setupBrowserHandlers(socket);
  try {
    const tab = await openTab(TARGET, "data:text/html,<h1 style='background:#369;color:#fff;height:100%'>stream e2e</h1>");
    const startRes = await new Promise((res) => socket.emitClient("browser:stream.start", { targetId: tab.id, width: 640, height: 480, profile: TARGET }, res));
    assert.ok(startRes?.ok, `stream.start failed: ${startRes?.error}`);

    const first = await collectFrames(9000);
    assert.ok(first, "no complete frame within 9s");
    assert.ok(lanes.every((l) => l === CHANNELS.file), "all chunks rode the file lane");
    // Hybrid: first frame = every tile changed → Chrome's jpeg passes through.
    assert.equal(first.entry.flags, 0, "first frame forwards the original jpeg");
    const jpeg = joinedPayload(first.entry);
    assert.equal(jpeg[0], 0xff, "passthrough payload is the raw JPEG SOI");
    assert.equal(jpeg[1], 0xd8);

    // The ack window must release on the client ack → a next frame flows.
    // (Small-edit granularity — one tile for a 20×20 blot — is covered
    // deterministically by the unit tests; here we only prove the pipe.)
    // One retry: an occasional engine CDP hiccup drops the first mutation.
    let next = null;
    for (let attempt = 0; attempt < 2 && !next; attempt++) {
      sentChunks.length = 0;
      socket.emitClient("browser:stream.ack", { targetId: tab.id, seq: first.seq + 50 });
      // Static page: a body-background change is reliable compositor damage.
      await new Promise((res) => socket.emitClient("browser:invoke", { action: "eval", payload: { targetId: tab.id, profile: TARGET, expression: `document.body.style.background='#c${3 + attempt}3'` } }, res));
      next = await collectFrames(6000);
    }
    assert.ok(next, "no frame after ack — window never released");
    assert.ok(next.seq > first.seq, `seq monotonic: ${next.seq} > ${first.seq}`);
    // The background repaint covers most of the viewport — still ≥ the hybrid
    // threshold only if the grid says so; assert whichever flavor arrived is
    // well-formed: passthrough jpeg or a tile batch with tiles.
    if (next.entry.flags === 1) {
      assert.ok(tileCountOf(next.entry) > 0, "tile batch carries tiles");
    } else {
      const j2 = joinedPayload(next.entry);
      assert.equal(j2[0], 0xff, "passthrough payload is JPEG");
    }

    socket.emitClient("browser:stream.stop", { targetId: tab.id });
    await closeTab(TARGET, tab.id).catch(() => {});
  } finally {
    unregisterProtocol(fakePm);
    await removeProfile(TARGET).catch(() => {});
  }
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL - ${name}: ${e.message}`);
  }
}
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log(`${tests.length} passed`);
