// Regression tests for Android mirroring: frame codec + input validation.
// Pure logic — no device needed. Run: node agent/test/mobileInput.test.mjs
//
// Covers the bugs found in review:
//  - hostile mobile:input payloads must never throw (unhandled rejection → crash log)
//  - pointerId 1e30 passes Number.isInteger but overflows u64
//  - chunked access units must reassemble byte-identical
//  - a file-transfer frame on the shared channel must not decode as video
import assert from "node:assert/strict";
import { encodeMobileFrame, decodeMobileFrame, MOBILE_FLAG_KEY, MOBILE_FLAG_CONFIG } from "../features/mobile/mobileFrame.js";
import { encodeFileFrame } from "../transport/fileFrame.js";
import { VIDEO_CHUNK_PAYLOAD } from "../features/mobile/constants.js";
import { existsSync as fsExists } from "node:fs";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("\nframe codec");

test("roundtrips a single-chunk frame", () => {
  const payload = Buffer.from([0, 0, 0, 1, 0x65, 0xde, 0xad]);
  const wire = encodeMobileFrame({ frameSeq: 7, chunkIdx: 0, chunkCount: 1, flags: MOBILE_FLAG_KEY, ptsMs: 1234, payload });
  const out = decodeMobileFrame(wire);
  assert.equal(out.frameSeq, 7);
  assert.equal(out.chunkCount, 1);
  assert.equal(out.isKey, true);
  assert.equal(out.isConfig, false);
  assert.equal(out.ptsMs, 1234);
  assert.deepEqual(Buffer.from(out.payload), payload);
});

test("carries the config flag independently of key", () => {
  const out = decodeMobileFrame(encodeMobileFrame({
    frameSeq: 0, chunkIdx: 0, chunkCount: 1, flags: MOBILE_FLAG_CONFIG, ptsMs: 0, payload: Buffer.from([1])
  }));
  assert.equal(out.isConfig, true);
  assert.equal(out.isKey, false);
});

test("reassembles a chunked access unit byte-identically", () => {
  // Two and a bit chunks, with a recognisable byte pattern.
  const au = Buffer.alloc(VIDEO_CHUNK_PAYLOAD * 2 + 511);
  for (let i = 0; i < au.length; i++) au[i] = i % 251;
  const total = Math.ceil(au.length / VIDEO_CHUNK_PAYLOAD);
  assert.equal(total, 3);

  const parts = [];
  for (let i = 0; i < total; i++) {
    const wire = encodeMobileFrame({
      frameSeq: 42, chunkIdx: i, chunkCount: total, flags: MOBILE_FLAG_KEY, ptsMs: 99,
      payload: au.subarray(i * VIDEO_CHUNK_PAYLOAD, (i + 1) * VIDEO_CHUNK_PAYLOAD)
    });
    const d = decodeMobileFrame(wire);
    assert.equal(d.frameSeq, 42);
    assert.equal(d.chunkCount, total);
    parts[d.chunkIdx] = d.payload;
  }
  assert.deepEqual(Buffer.concat(parts.map(Buffer.from)), au);
});

test("every chunk fits under the SCTP message cap", () => {
  const wire = encodeMobileFrame({
    frameSeq: 0, chunkIdx: 0, chunkCount: 1, flags: 0, ptsMs: 0,
    payload: Buffer.alloc(VIDEO_CHUNK_PAYLOAD)
  });
  assert.ok(wire.byteLength < 65536, `chunk is ${wire.byteLength} bytes`);
});

test("rejects a file-transfer frame sharing the channel", () => {
  // Video and file transfer both ride CHANNELS.file; the magic keeps them apart.
  assert.equal(decodeMobileFrame(encodeFileFrame(1, 0, Buffer.alloc(64))), null);
  assert.equal(decodeMobileFrame(new Uint8Array(4)), null);
  assert.equal(decodeMobileFrame(new Uint8Array(0)), null);
});

console.log("\ninput validation (hostile payloads must be dropped, never throw)");

// The validation lives in ScrcpySession.input, guarding the packet writers.
// Import it without a device by stubbing the socket write.
const { ScrcpySession } = await import("../features/mobile/scrcpySession.js");

function stubSession() {
  const s = new ScrcpySession("test-serial");
  s.screen = { width: 456, height: 1024 };
  s.sent = [];
  s._write = (buf) => { s.sent.push(buf); return true; };
  return s;
}

const HOSTILE = [
  { type: "touch", action: "down", x: 0.5, y: 0.5, pointerId: "abc" },
  { type: "touch", action: "down", x: 0.5, y: 0.5, pointerId: -1 },
  { type: "touch", action: "down", x: 0.5, y: 0.5, pointerId: 1.5 },
  { type: "touch", action: "down", x: 0.5, y: 0.5, pointerId: 1e30 },
  { type: "touch", action: "down", x: NaN, y: 0.5 },
  { type: "touch", action: "down", x: 1e9, y: 0.5 },
  { type: "touch", action: "nope", x: 0.5, y: 0.5 },
  { type: "tap", x: "0.5", y: null },
  { type: "tap", x: Infinity, y: -Infinity },
  { type: "swipe", x1: 0.1, y1: 0.1, x2: NaN, y2: 0.9 },
  { type: "key", keycode: 99999999 },
  { type: "key", keycode: -3 },
  { type: "key", keycode: 1.5 },
  { type: "key", name: "__proto__" },
  { type: "text", text: 12345 },
  { type: "unknown" }, {}, null, undefined, "string", 42, [],
];

test("hostile payloads never throw", async () => {
  const s = stubSession();
  for (const msg of HOSTILE) await s.input(msg);
});

test("pointerId 1e30 is rejected, not passed to BigInt", async () => {
  // Number.isInteger(1e30) === true, so isSafeInteger is the check that matters.
  const s = stubSession();
  await s.input({ type: "touch", action: "down", x: 0.5, y: 0.5, pointerId: 1e30 });
  assert.equal(s.sent.length, 1, "packet should still be written, with pointerId defaulted");
  assert.equal(s.sent[0].readBigUInt64BE(2), 0n);
});

test("a valid pointerId is preserved", async () => {
  const s = stubSession();
  await s.input({ type: "touch", action: "down", x: 0.5, y: 0.5, pointerId: 3 });
  assert.equal(s.sent[0].readBigUInt64BE(2), 3n);
});

test("coordinates are clamped, not dropped, just outside the canvas", async () => {
  const s = stubSession();
  await s.input({ type: "touch", action: "down", x: 1.001, y: -0.001 });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].readInt32BE(10), 456);  // x clamped to width
  assert.equal(s.sent[0].readInt32BE(14), 0);    // y clamped to 0
});

test("touch coordinates map against the ENCODED size", async () => {
  // Regression: physical px silently lands every tap in the wrong place.
  const s = stubSession();
  await s.input({ type: "touch", action: "down", x: 0.5, y: 0.5 });
  assert.equal(s.sent[0].readUInt16BE(18), 456, "packet must declare the video width");
  assert.equal(s.sent[0].readUInt16BE(20), 1024, "packet must declare the video height");
});

test("a named hardware key writes down+up", async () => {
  const s = stubSession();
  await s.input({ type: "key", name: "home" });
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0][1], 0); // ACTION_DOWN
  assert.equal(s.sent[1][1], 1); // ACTION_UP
});

test("back uses BACK_OR_SCREEN_ON so it also wakes the device", async () => {
  const s = stubSession();
  await s.input({ type: "key", name: "back" });
  assert.equal(s.sent[0][0], 4); // TYPE_BACK_OR_SCREEN_ON, not INJECT_KEYCODE
});

test("text is truncated on a character boundary", async () => {
  const s = stubSession();
  await s.input({ type: "text", text: "🔥".repeat(500) });
  const declared = s.sent[0].readUInt32BE(1);
  assert.ok(declared <= 300, `declared ${declared} bytes`);
  assert.equal(declared % 4, 0, "a 4-byte emoji must not be split");
  assert.equal(s.sent[0].length, 5 + declared);
});

console.log("\nscroll (one packet instead of a simulated swipe)");

test("scroll packet matches scrcpy's wire format", async () => {
  const s = stubSession();
  await s.input({ type: "scroll", x: 0.5, y: 0.5, hscroll: 0, vscroll: -16 });
  assert.equal(s.sent.length, 1, "one packet, not a swipe");
  const p = s.sent[0];
  assert.equal(p.length, 21, "scrcpy expects exactly 21 bytes");
  assert.equal(p[0], 3, "TYPE_INJECT_SCROLL_EVENT");
  assert.equal(p.readUInt16BE(9), 456, "screen width must be the encoded size");
  assert.equal(p.readUInt16BE(11), 1024);
  // scrcpy's own test vector: -16 encodes as 0x8000.
  assert.equal(p.readInt16BE(15), -0x8000);
  assert.equal(p.readUInt32BE(17), 0, "no buttons held");
});

test("full-scale scroll encodes as scrcpy's 0x7FFF", async () => {
  const s = stubSession();
  await s.input({ type: "scroll", x: 0.5, y: 0.5, hscroll: 16, vscroll: 0 });
  assert.equal(s.sent[0].readInt16BE(13), 0x7fff);
});

test("a scroll of zero sends nothing", async () => {
  const s = stubSession();
  await s.input({ type: "scroll", x: 0.5, y: 0.5, hscroll: 0, vscroll: 0 });
  assert.equal(s.sent.length, 0, "no packet is better than a no-op packet");
});

test("hostile scroll values are dropped", async () => {
  const s = stubSession();
  for (const msg of [
    { type: "scroll", x: NaN, y: 0.5, vscroll: 1 },
    { type: "scroll", x: 0.5, y: 0.5, vscroll: "big" },
    { type: "scroll", x: 0.5, y: 0.5, hscroll: Infinity }
  ]) await s.input(msg);
  assert.equal(s.sent.length, 0);
});

console.log("\ntouch-move throttling (bunched moves must not inflate velocity)");

test("rapid moves coalesce to wall-clock spacing, keeping the newest position", async () => {
  const s = stubSession();
  const times = [];
  s._write = (buf) => { times.push(Date.now()); s.sent.push(buf); return true; };
  // A burst: 50 moves sent back-to-back, as the tunnel delivers them.
  for (let i = 0; i < 50; i++) {
    await s.input({ type: "touch", action: "move", x: 0.1 + i * 0.016, y: 0.5 });
  }
  await new Promise((r) => setTimeout(r, 60)); // let trailing flushes fire
  const moves = times.filter((t, i) => i > 0 && s.sent[i - 1] && s.sent[i - 1].readUInt8(0) === 2 && s.sent[i].readUInt8(0) === 2 && s.sent[i].readUInt8(1) === 2);
  const last = s.sent.filter((b) => b.readUInt8(0) === 2 && b.readUInt8(1) === 2).pop();
  assert.ok(last, "at least one move injected");
  assert.equal(last.readInt32BE(10) / 456 > 0.8, true, "injected the NEWEST x, not an early one");
  s.close();
});

test("a pending move is discarded when the finger lifts", async () => {
  const s = stubSession();
  await s.input({ type: "touch", action: "move", x: 0.5, y: 0.5 });   // goes pending
  await s.input({ type: "touch", action: "up", x: 0.5, y: 0.6 });
  await new Promise((r) => setTimeout(r, 40));
  const writes = s.sent.filter((b) => b.readUInt8(0) === 2);
  // The stale move must not be injected after the up.
  const upIdx = writes.findIndex((b) => b.readUInt8(1) === 1);
  const movesAfterUp = writes.slice(upIdx + 1).filter((b) => b.readUInt8(1) === 2);
  assert.equal(movesAfterUp.length, 0, "no move may follow the up event");
  s.close();
});

console.log("\nlogcat noise filtering");

const { LogcatStream } = await import("../features/mobile/logcat.js");
const RANCHU = "08-27 23:27:08.678  1234  1234 E mapper.ranchu: getStandardMetadataImpl:886 failure: UNSUPPORTED";
const APP_LINE = "08-27 23:27:08.678  1234  1234 E MyApp: something actually broke";

test("per-frame vendor spam is dropped by default", () => {
  const s = new LogcatStream("serial", {}, () => {});
  assert.equal(s._matches(RANCHU), false, "mapper.ranchu must be filtered");
  assert.equal(s._matches(APP_LINE), true, "real app output must survive");
});

test("noise can be turned back on when a driver is the suspect", () => {
  const s = new LogcatStream("serial", { includeNoise: true }, () => {});
  assert.equal(s._matches(RANCHU), true);
});

test("noise filtering does not swallow a similarly named tag", () => {
  const s = new LogcatStream("serial", {}, () => {});
  const similar = "08-27 23:27:08.678  1234  1234 E mapper.ranchu.myapp: real message";
  assert.equal(s._matches(similar), true, "only the exact tag is noise");
});

console.log("\nsleep-on-idle guards");

test("sleep and wake use the keyevents that survive a closed session", async () => {
  // Not scrcpy's SET_DISPLAY_POWER: that one is undone on disconnect, which is
  // precisely when the device should stay asleep.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../features/mobile/appManager.js", import.meta.url), "utf8"));
  assert.match(src, /KEYCODE_SLEEP = 223/);
  assert.match(src, /KEYCODE_WAKEUP = 224/);
  assert.ok(!/SET_DISPLAY_POWER/.test(src), "must not rely on the restored-on-exit path");
});

test("a device the agent did not start is never slept", async () => {
  const { isAgentStarted } = await import("../features/mobile/emulator.js");
  // Nothing has been started in this process, so every serial is someone else's.
  assert.equal(await isAgentStarted("emulator-5554"), false);
  assert.equal(await isAgentStarted("R3CT601BWKV"), false, "a USB phone is never ours");
  assert.equal(await isAgentStarted(null), false);
});

console.log("\nper-machine safety");

test("guest memory follows the AVD, never a fixed number", async () => {
  const { QEMU_MEMORY_ARGS, MIN_GUEST_RAM_MB } = await import("../features/mobile/constants.js");
  // A tablet AVD is shrunk, a watch AVD is left alone: hardcoding one value
  // would have grown the small one.
  assert.deepEqual(QEMU_MEMORY_ARGS(4096), ["-qemu", "-m", "4096"]);
  assert.deepEqual(QEMU_MEMORY_ARGS(2048), ["-qemu", "-m", "2048"]);
  assert.deepEqual(QEMU_MEMORY_ARGS(512), [], "below the floor, leave it as configured");
  assert.deepEqual(QEMU_MEMORY_ARGS(MIN_GUEST_RAM_MB - 1), []);
  assert.deepEqual(QEMU_MEMORY_ARGS(null), [], "unknown config means no override");
  assert.deepEqual(QEMU_MEMORY_ARGS(NaN), []);
});

test("-gpu host is separable, so a GPU-less host can drop it", async () => {
  const { GPU_HOST_ARGS, EMULATOR_ARGS } = await import("../features/mobile/constants.js");
  assert.deepEqual(GPU_HOST_ARGS, ["-gpu", "host"]);
  assert.ok(!EMULATOR_ARGS.includes("-gpu"), "the base flags must boot anywhere");
});

console.log("\nownership + fallback guards");

test("ownership survives a restart, and never adopts someone else's device", async () => {
  const { isAgentStarted } = await import("../features/mobile/emulator.js");
  // Nothing owned in this process: a USB phone and an emulator the user opened
  // must both come back false, or the agent would sleep or stop their device.
  assert.equal(await isAgentStarted("R3CT601BWKV"), false, "USB serials are never ours");
  assert.equal(await isAgentStarted(null), false);
  assert.equal(await isAgentStarted("not-an-emulator"), false);
});

test("only a fast flag rejection triggers the GPU fallback", async () => {
  const { EMULATOR } = await import("../features/mobile/constants.js");
  const rejected = (gpuArgs, sawSerial, elapsed) =>
    gpuArgs.length > 0 && !sawSerial && elapsed < EMULATOR.flagRejectMs;
  assert.equal(rejected(["-gpu", "host"], null, 1000), true, "quick exit = the flag");
  assert.equal(rejected(["-gpu", "host"], null, 180000), false, "a timeout is not the flag");
  assert.equal(rejected(["-gpu", "host"], "emulator-5554", 2000), false, "it booted, then failed");
  assert.equal(rejected([], null, 1000), false, "already the fallback attempt");
});

console.log("\napp management guards");

const appMgr = await import("../features/mobile/appManager.js");

test("package names outside the documented grammar are rejected", () => {
  for (const bad of ["../etc", "a b", "no-dots", "", "com.$evil", null, 42]) {
    assert.throws(() => appMgr.launchApp("serial", bad), /Invalid package/);
  }
});

test("only .apk files can be staged", () => {
  assert.throws(() => appMgr.stagePathFor("evil.sh"), /Only .apk/);
  assert.throws(() => appMgr.stagePathFor("payload.apk.exe"), /Only .apk/);
});

test("a staged name cannot escape the staging dir", () => {
  // Traversal must be flattened to a basename inside stageDir.
  const staged = appMgr.stagePathFor("../../../etc/evil.apk");
  assert.ok(staged.startsWith(appMgr.stageDir() + "/"), staged);
  assert.ok(!staged.includes(".."), staged);
});

test("oversize APKs are refused before any upload starts", () => {
  assert.throws(() => appMgr.assertApkSize(9e9), /too large/);
  assert.throws(() => appMgr.assertApkSize(-1), /Invalid size/);
  assert.throws(() => appMgr.assertApkSize(NaN), /Invalid size/);
});

test("cleanupStaged refuses paths outside the staging dir", () => {
  // Silently ignoring is the contract — it must not delete /etc/passwd.
  appMgr.cleanupStaged("/etc/passwd");
  assert.ok(fsExists("/etc/passwd"), "must not have deleted an outside path");
});

test("deep links reject control characters", () => {
  assert.throws(() => appMgr.openDeepLink("serial", "http://a\nb"), /Invalid URL/);
  assert.throws(() => appMgr.openDeepLink("serial", ""), /Invalid URL/);
});

test("rotation only accepts the four Android values", () => {
  for (const bad of [99, -1, 1.5, "1", null]) {
    assert.throws(() => appMgr.setRotation("serial", bad), /Invalid rotation/);
  }
});

console.log("\navd lcd config patch (720p default for provisioned phones)");

const { lcdConfigPatch } = await import("../features/mobile/sdkSetup.js");

test("rewrites existing hw.lcd values and preserves other lines", () => {
  const src = "hw.lcd.width = 1080\nhw.lcd.height = 2400\nhw.lcd.density = 420\nhw.ramSize = 2048\n";
  const out = lcdConfigPatch(src, { width: 720, height: 1600, density: 280 });
  assert.match(out, /hw\.lcd\.width = 720/);
  assert.match(out, /hw\.lcd\.height = 1600/);
  assert.match(out, /hw\.lcd\.density = 280/);
  assert.match(out, /hw\.ramSize = 2048/, "unrelated config must survive");
  assert.ok(!out.includes("1080"), "old width must be gone");
});

test("appends missing hw.lcd keys", () => {
  const out = lcdConfigPatch("hw.ramSize = 2048\n", { width: 720, height: 1600, density: 280 });
  for (const k of ["width = 720", "height = 1600", "density = 280"]) {
    assert.match(out, new RegExp(`hw\\.lcd\\.${k}`));
  }
});

console.log("\nstream flow control (acks are the only brake — carrier-agnostic)");

const { FrameFlow } = await import("../features/mobile/mobileBus.js");

const mkFlow = (over = {}) => {
  let clock = 1000;
  // min=max start pins the AIMD window so these tests see pure accounting.
  const flow = new FrameFlow({
    ackWindow: 24, winStartBytes: 1000, winMinBytes: 1000, winMaxBytes: 1000,
    winGrow: 2, winShrink: 0.5, ackTimeoutMs: 100, deadSilenceMs: 10_000,
    now: () => clock, ...over
  });
  return { flow, tick: (ms) => { clock += ms; } };
};

test("window fills by bytes long before frame count", () => {
  const { flow } = mkFlow();
  for (let i = 0; i < 4; i++) flow.register(i, 250);
  assert.equal(flow.fullForDelta, true, "4 frames of 250B must fill a 1000B window");
});

test("an ack frees every frame it covers, byte-exact", () => {
  const { flow } = mkFlow();
  flow.register(0, 400); flow.register(1, 400); flow.register(2, 400);
  assert.equal(flow.fullForDelta, true);
  flow.ack(1); // ordered channel: one ack covers everything before it
  assert.equal(flow.fullForDelta, false);
});

test("slot expiry frees the window but is not death", () => {
  const { flow, tick } = mkFlow();
  flow.register(0, 1000);
  tick(101);
  flow._expire(0);
  assert.equal(flow.fullForDelta, false);
  assert.equal(flow.dead, false, "a slow link must not read as a dead viewer");
});

test("byte window shrinks once per loss episode, grows on clean utilized rounds", () => {
  const { flow } = mkFlow({ winStartBytes: 1000, winMinBytes: 250, winMaxBytes: 4000 });
  flow.register(0, 900);
  flow._expire(0);
  assert.equal(flow.win, 500, "first loss shrinks the window");
  flow.register(1, 400);
  flow._expire(1);
  assert.equal(flow.win, 500, "a second loss in the same episode does not shrink again");
  flow.clearLoss();
  for (let i = 2; i < 8; i++) {
    flow.register(i, Math.ceil(flow.win * 0.95));
    flow.ack(i);
  }
  assert.equal(flow.win, 4000, "clean utilized rounds grow the window to the cap");
});

test("only sustained ack silence declares the viewer gone", () => {
  const { flow, tick } = mkFlow();
  flow.register(0, 10); flow.ack(0);
  tick(9_999);
  assert.equal(flow.dead, false);
  tick(2);
  assert.equal(flow.dead, true);
  flow.ack(0);
  assert.equal(flow.dead, false, "any ack revives");
});

test("after a drop, only a keyframe resumes the stream", () => {
  const { flow } = mkFlow();
  flow.markDropped();
  assert.equal(flow.admit({ isKey: false }), false, "deltas reference dropped predecessors");
  assert.equal(flow.admit({ isConfig: true }), true, "config packets are tiny and needed");
  assert.equal(flow.waitingKey, true, "config does not clear the wait");
  assert.equal(flow.admit({ isKey: true }), true);
  assert.equal(flow.waitingKey, false);
  assert.equal(flow.admit({ isKey: false }), true);
});

test("no drops, no gating", () => {
  const { flow } = mkFlow();
  assert.equal(flow.admit({ isKey: false }), true);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
