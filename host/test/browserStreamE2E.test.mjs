// E2E: real Chrome screencast -> tile batches at the transport edge.
// Exercises the exact path the pane uses: stream.start -> CDP screencastFrame ->
// handleFrame (ack window) -> tile diff/encode -> pm.sendTiles(browser lane) ->
// client ack releases the window. The only fake is the PM at the wire edge.
// Run: node test/browserStreamE2E.test.mjs (skips silently without Chrome)
import assert from "node:assert/strict";
import "./chromeGuard.mjs";
import { closeTab, createProfile, openTab, removeProfile, resolveChromeBinary } from "../features/browser/browserEngine.js";
import { setupBrowserHandlers } from "../features/browser/browserSocket.js";
import { CHANNELS } from "../lib/transportConstants.js";

// Unique profile per run: the previous run's graceful Chrome close releases
// its profile lock async — a reused name races the singleton forward.
const TARGET = `e2e-stream-${Date.now().toString(36)}`;

// Fake PM at the wire edge: records every tile batch + control event.
function makePm() {
  return {
    batches: [], controls: [],
    emit(event, payload) { this.controls.push({ event, payload }); return true; },
    sendTiles(payload, _encode, channel) { this.batches.push({ ...payload, channel }); return payload.tiles; }
  };
}

// Minimal socket: setupBrowserHandlers only needs .on, .id and data.protocol.
function makeSocket(id, pm) {
  const handlers = new Map();
  return {
    id,
    connected: true,
    data: { protocol: pm },
    on: (ev, fn) => handlers.set(ev, fn),
    emitClient: (ev, data, cb) => handlers.get(ev)?.(data, cb)
  };
}

// Resolves with the next batch past `from`, or null on timeout.
function nextBatch(pm, from, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (pm.batches.length > from || Date.now() > deadline) {
        clearInterval(tick);
        resolve(pm.batches[from] || null);
      }
    }, 50);
  });
}

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("real Chrome frames arrive as tile batches on the browser lane, only for the watcher", async () => {
  if (!resolveChromeBinary()) return;
  await createProfile(TARGET);
  const pm = makePm();
  const bystander = makePm();
  const socket = makeSocket("sock-e2e", pm);
  setupBrowserHandlers(socket);
  setupBrowserHandlers(makeSocket("sock-bystander", bystander)); // connected, watches nothing
  try {
    const tab = await openTab(TARGET, "data:text/html,<h1 style='background:#369;color:#fff;height:100%'>stream e2e</h1>");
    const startRes = await new Promise((res) => socket.emitClient("browser:stream.start", { targetId: tab.id, width: 640, height: 480, profile: TARGET }, res));
    assert.ok(startRes?.ok, `stream.start failed: ${startRes?.error}`);

    const first = await nextBatch(pm, 0, 9000);
    assert.ok(first, "no tile batch within 9s");
    assert.equal(first.channel, CHANNELS.browser, "tiles ride the browser lane");
    assert.ok(first.tiles.length > 0, "first batch carries tiles");
    const dims = pm.controls.find((c) => c.event === "browser:screen-dimensions");
    assert.ok(dims && dims.payload.targetId === tab.id && dims.payload.frameW > 0, "size announced before/with the first tiles");

    // The ack window must release on the client ack -> a next frame flows.
    // One retry: an occasional engine CDP hiccup drops the first mutation.
    let next = null;
    for (let attempt = 0; attempt < 2 && !next; attempt++) {
      const from = pm.batches.length;
      socket.emitClient("browser:stream.ack", { targetId: tab.id, ts: Date.now() + 60_000 });
      // Static page: a body-background change is reliable compositor damage.
      await new Promise((res) => socket.emitClient("browser:invoke", { action: "eval", payload: { targetId: tab.id, profile: TARGET, expression: `document.body.style.background='#c${3 + attempt}3'` } }, res));
      next = await nextBatch(pm, from, 6000);
    }
    assert.ok(next, "no frame after ack - window never released");
    assert.ok(next.tiles.length > 0, "tile batch carries tiles");
    assert.equal(bystander.batches.length, 0, "a client not watching the tab gets no tiles");

    socket.emitClient("browser:stream.stop", { targetId: tab.id });
    await closeTab(TARGET, tab.id).catch(() => {});
  } finally {
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
