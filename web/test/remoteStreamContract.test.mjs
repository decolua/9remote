// Source-contract tests for useRemoteStream (extracted from RemoteDesktop).
//
// These rules are not expressible as unit tests without a React renderer, but each
// one has already caused a user-visible bug:
//   • a listener subscribed and never removed → duplicate tile writes after re-entry
//   • request-screen-with-hashes inside the handshake → races the stream loop, the
//     agent marks the client synced and only sends diffs → black canvas
//   • widening the socket effect's deps → re-subscribe storm → dropped frames
//
// Run: node --import ./test/loader-alias.mjs web/test/remoteStreamContract.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC = readFileSync(__dirname + "../features/remote/hooks/useRemoteStream.js", "utf8");

const on = [...SRC.matchAll(/socket\.on\("([^"]+)"/g)].map((m) => m[1]);
const off = [...SRC.matchAll(/socket\.off\("([^"]+)"/g)].map((m) => m[1]);

test("every socket listener is removed on cleanup", () => {
  assert.deepEqual([...on].sort(), [...off].sort());
});

test("no listener is subscribed twice", () => {
  assert.equal(new Set(on).size, on.length, `duplicates: ${on.filter((e, i) => on.indexOf(e) !== i)}`);
});

test("the full agent event set is still handled", () => {
  // Losing any of these silently breaks a feature (tiles, lock overlay, clipboard,
  // monitor switch, cursor) with no error surfaced.
  for (const ev of [
    "screen-dimensions", "full-screen-data", "tiles-data", "tiles-data-binary",
    "tiles-bin-v2", "tiles-meta", "screen-error", "screen-locked", "unlock-result",
    "remote:ready", "clipboard-update", "monitors", "frame_meta", "cursor-shape"
  ]) {
    assert.ok(on.includes(ev), `missing listener: ${ev}`);
  }
  assert.equal(on.length, 14);
});

test("restream handshake keeps its exact order and stays hash-free", () => {
  const i = SRC.indexOf("const doRestream");
  const body = SRC.slice(i, SRC.indexOf("};", i));
  const order = [...body.matchAll(/emit\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["get-screen-dimensions", "get-unlock-state", "start-streaming"]);
  assert.ok(!order.includes("request-screen-with-hashes"),
    "a hash request here races the stream loop → black canvas");
  assert.ok(body.includes("cleanupTiles()"), "stale hashes must be dropped first");
});

test("the socket effect stays keyed on [connected] only", () => {
  // Adding deps re-subscribes on every render of a changing callback → tile loss.
  assert.match(SRC, /eslint-disable-next-line react-hooks\/exhaustive-deps\s*\n\s*\}, \[connected\]\);/);
});

test("cleanup stops the stream before detaching, and frees tiles + zoom timer", () => {
  const i = SRC.indexOf('return () => {\n      socket.emit("stop-streaming")');
  assert.ok(i > 0, "cleanup must emit stop-streaming first");
  const cleanup = SRC.slice(i);
  assert.ok(cleanup.indexOf('socket.emit("stop-streaming")') < cleanup.indexOf("socket.off("));
  assert.ok(cleanup.includes("cleanupTiles();"));
  assert.ok(cleanup.includes("zoomGestureTimeoutRef"));
});

test("hidden-tab pause never uses the hash path", () => {
  const i = SRC.indexOf("const onVisibility");
  const body = SRC.slice(i, SRC.indexOf("};", i));
  assert.ok(body.includes('socket.emit("stop-streaming")'));
  assert.ok(body.includes('socket.emit("start-streaming")'));
  const emitted = [...body.matchAll(/emit\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(emitted, ["stop-streaming", "start-streaming"],
    "resume must not race the stream loop with a hash request");
});

test("binary tile frames go through the shared header parser (no re-duplication)", () => {
  assert.match(SRC, /tileStatsFrom\(/, "must reuse lib/tileBinaryHeader");
  assert.ok(!/getUint32\(0, true\)/.test(SRC), "header parsing must not be inlined again");
  const defs = (SRC.match(/const trackBinary = /g) || []).length;
  const calls = (SRC.match(/^\s+trackBinary\(/gm) || []).length;
  assert.equal(defs, 1, "one shared helper");
  assert.equal(calls, 2, "used by both the v1 and v2 listeners");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
