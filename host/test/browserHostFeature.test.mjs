import assert from "node:assert/strict";
import "./chromeGuard.mjs";
import fs from "node:fs";
import sharp from "sharp";
import os from "node:os";
import path from "node:path";

import { clampViewport, snapRaster, cdpTouchPoints, frameAdmitted, hasActiveStreamFor, handleFrame, releaseAck, startStream, stopStream, compareRecordTileHashes } from "../features/browser/stream.js";
import { ANTI_DETECTION_SCRIPT, headlessOverride, identityOverride, mobileOverride, stripHeadlessUa } from "../features/browser/antiDetection.js";
import { parseCookiesJson, parseNetscapeCookies } from "../features/browser/cookieImport.js";
import { closeTab, createProfile, getOrLaunchBrowser, idleCloseDue, listProfiles, listTabs, normalizeUrlInput, openTab, peekBrowser, removeProfile, resolveChromeBinary, scoreHistory, sweepIdleBrowsers } from "../features/browser/browserEngine.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("clampViewport caps and defaults", () => {
  assert.deepEqual(clampViewport({ width: 4000, height: 0 }), { width: 1920, height: 1280, scale: 1, mobile: false });
  assert.deepEqual(clampViewport({ width: 800, height: 1200 }), { width: 800, height: 1200, scale: 1, mobile: false });
  assert.deepEqual(clampViewport({}), { width: 720, height: 1280, scale: 1, mobile: false });
  // Retina scale rides along, capped at 2
  assert.deepEqual(clampViewport({ width: 500, height: 400, scale: 3 }), { width: 500, height: 400, scale: 2, mobile: false });
  assert.equal(clampViewport({ width: 375, height: 667, mobile: true }).mobile, true);
});

test("snapRaster: desktop raster is integral, mobile keeps its CSS size", () => {
  for (const [w, h, s] of [[1284, 397, 1.25], [1284, 601, 1.25], [777, 449, 1.25], [1001, 555, 1.25], [1284, 397, 0.75], [1284, 397, 1]]) {
    const { size, box } = snapRaster({ width: w, height: h, mobile: false }, s);
    assert.ok(size.width <= w && w - size.width < 4 && size.height <= h && h - size.height < 4, `${w}x${h}@${s} shrinks by <4px`);
    assert.ok(Number.isInteger(box.width) && Number.isInteger(box.height), `${w}x${h}@${s} box is integral`);
    assert.equal(box.width, size.width * s);
    assert.equal(box.height, size.height * s);
  }
  assert.deepEqual(snapRaster({ width: 1284, height: 397, mobile: false }, 1.25).size, { width: 1284, height: 396, mobile: false });
  const m = snapRaster({ width: 390, height: 844, mobile: true }, 1.25);
  assert.equal(m.size.width, 390, "mobile CSS size untouched");
  assert.deepEqual(m.box, { width: 488, height: 1055 });
});

test("frameAdmitted enforces interval floor", () => {
  assert.equal(frameAdmitted(0, 200), true);
  assert.equal(frameAdmitted(1000, 1020), false); // 20ms < 33ms floor
  assert.equal(frameAdmitted(1000, 1040), true); // 40ms ≥ 33ms floor
});

test("stripHeadlessUa removes Headless token", () => {
  assert.equal(
    stripHeadlessUa("Mozilla/5.0 HeadlessChrome/137.0.0.0 Safari/537.36"),
    "Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36"
  );
});

test("anti-detection script parses cleanly", () => {
  new Function(ANTI_DETECTION_SCRIPT);
});

test("anti-detection script stays native where Chrome already matches headful", () => {
  // Each of these spoofs ADDS a tell a genuine build never shows (own-property
  // webdriver, csi/loadTimes stubs, plain-array plugins, patched Permissions).
  assert.doesNotMatch(ANTI_DETECTION_SCRIPT, /navigator, 'webdriver'/);
  assert.doesNotMatch(ANTI_DETECTION_SCRIPT, /loadTimes|csi/);
  assert.doesNotMatch(ANTI_DETECTION_SCRIPT, /navigator, 'plugins'|navigator, 'mimeTypes'/);
  assert.doesNotMatch(ANTI_DETECTION_SCRIPT, /Permissions/);
  assert.match(ANTI_DETECTION_SCRIPT, /WebGL2RenderingContext/); // prototype-level GPU patch
  assert.match(ANTI_DETECTION_SCRIPT, /SwiftShader/); // swap gated on software rasterizer
  assert.match(ANTI_DETECTION_SCRIPT, /languages/); // fallback only when empty
});

test("headlessOverride strips the token, keeps native grease brands", () => {
  const identity = {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HeadlessChrome/155.0.0.0 Safari/537.36",
    hints: {
      brands: [{ brand: "Google Chrome", version: "155" }, { brand: "Chromium", version: "155" }, { brand: "Not(A:Brand", version: "24" }],
      fullVersionList: [{ brand: "Google Chrome", version: "155.0.8059.27" }, { brand: "Chromium", version: "155.0.8059.27" }, { brand: "Not(A:Brand", version: "24.0.0.0" }],
      mobile: false, platform: "macOS", platformVersion: "26.5.1", architecture: "arm", bitness: "64", model: ""
    }
  };
  const params = headlessOverride(identity);
  assert.ok(params, "override params built");
  assert.ok(!/Headless/i.test(params.userAgent));
  assert.ok(!JSON.stringify(params.userAgentMetadata).includes("Headless"));
  // Native grease brand must survive — a hand-built 2-brand list gets the
  // whole override rejected by CDP ("Invalid parameters").
  assert.ok(params.userAgentMetadata.brands.some((b) => b.brand.includes("Not")), "grease brand preserved");
  assert.equal(params.userAgentMetadata.platformVersion, "26.5.1");
  assert.equal(params.userAgentMetadata.fullVersion, "155.0.8059.27");
  assert.equal(headlessOverride({ userAgent: "Mozilla/5.0 Chrome/155.0.0.0", hints: {} }), null); // headed: no-op
});

test("mobileOverride builds a consistent Android identity from the real version", () => {
  const identity = {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HeadlessChrome/155.0.0.0 Safari/537.36",
    hints: {
      brands: [{ brand: "Google Chrome", version: "155" }, { brand: "Chromium", version: "155" }, { brand: "Not(A:Brand", version: "24" }],
      fullVersionList: [{ brand: "Google Chrome", version: "155.0.8059.27" }, { brand: "Chromium", version: "155.0.8059.27" }, { brand: "Not(A:Brand", version: "24.0.0.0" }],
      mobile: false, platform: "macOS", platformVersion: "26.5.1", architecture: "arm", bitness: "64", model: ""
    }
  };
  const params = mobileOverride(identity);
  assert.match(params.userAgent, /Android 14; Pixel 8\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/155\.0\.8059\.27 Mobile Safari\/537\.36$/);
  assert.equal(params.userAgentMetadata.mobile, true);
  assert.equal(params.userAgentMetadata.platform, "Android");
  assert.equal(params.userAgentMetadata.platformVersion, "14.0.0");
  assert.equal(params.userAgentMetadata.model, "Pixel 8");
  // Real Chrome version + grease brand must carry over untouched.
  assert.equal(params.userAgentMetadata.brands.some((b) => b.brand.includes("Not")), true);
  assert.equal(params.userAgentMetadata.fullVersion, "155.0.8059.27");
  assert.equal(mobileOverride({ userAgent: "x" }), null); // no hints -> no lie
});

test("identityOverride restores an identity verbatim, stripping only Headless", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/155.0.0.0 Safari/537.36";
  const params = identityOverride({ userAgent: ua, hints: { brands: [{ brand: "Chromium", version: "155" }], mobile: false } });
  assert.equal(params.userAgent, ua); // no Headless token -> copied verbatim (restore feeds the CACHED desktop identity)
  assert.equal(params.userAgentMetadata.mobile, false);
  assert.equal(identityOverride(null), null);
});

test("cookie parsing: JSON and Netscape formats", () => {
  const jsonRaw = JSON.stringify([
    { name: "sid", value: "123", domain: ".example.com", path: "/", secure: true }
  ]);
  const parsedJson = parseCookiesJson(jsonRaw);
  assert.equal(parsedJson.length, 1);
  assert.equal(parsedJson[0].name, "sid");
  assert.equal(parsedJson[0].domain, ".example.com");

  const netscapeRaw = `.example.com\tTRUE\t/\tTRUE\t1700000000\tsid\txyz\n`;
  const parsedNetscape = parseNetscapeCookies(netscapeRaw);
  assert.equal(parsedNetscape.length, 1);
  assert.equal(parsedNetscape[0].value, "xyz");
});

test("profile management CRUD", async () => {
  const pName = `test_${Date.now()}`;
  createProfile(pName);
  const list = listProfiles();
  const created = list.find((p) => p.name === pName);
  assert.ok(created);

  await removeProfile(pName);
  const afterList = listProfiles();
  assert.equal(afterList.some((p) => p.name === pName), false);
});

test("scoreHistory ranks prefix > host > substring > title", () => {
  const list = [
    { url: "https://docs.example.com/guide", ts: 1 },
    { url: "https://example.com/guide", ts: 2 },
    { url: "https://other.org/page", title: "Guide page", ts: 3 },
    { url: "https://zzz.io/ex", ts: 4 }
  ];
  const ranked = scoreHistory(list, "example");
  assert.equal(ranked[0].url, "https://example.com/guide"); // host match beats substring
  assert.equal(ranked[1].url, "https://docs.example.com/guide");
  const byTitle = scoreHistory(list, "guide page");
  assert.equal(byTitle[0].url, "https://other.org/page");
  assert.equal(scoreHistory(list, "nomatch").length, 0);
  // Empty query: recent first, capped at 8
  assert.equal(scoreHistory(list, "")[0].url, "https://zzz.io/ex");
});

test("normalizeUrlInput: scheme, https-prefix, search fallback", () => {
  assert.equal(normalizeUrlInput(""), "about:blank");
  assert.equal(normalizeUrlInput("about:blank"), "about:blank");
  assert.equal(normalizeUrlInput("http://x.test/a"), "http://x.test/a");
  assert.equal(normalizeUrlInput("example.com"), "https://example.com");
  assert.equal(normalizeUrlInput("example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(normalizeUrlInput("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrlInput("127.0.0.1"), "http://127.0.0.1");
  assert.equal(
    normalizeUrlInput("how to center a div"),
    "https://www.google.com/search?q=" + encodeURIComponent("how to center a div")
  );
});

test("cdpTouchPoints normalizes and caps the touch batch", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ x: i * 10, y: i * 20 }));
  const pts = cdpTouchPoints(many);
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[1], { x: 10, y: 20 });
  assert.deepEqual(cdpTouchPoints(null), []);
  assert.deepEqual(cdpTouchPoints([{ x: "12", y: "bad" }]), [{ x: 12, y: 0 }]);
});

test("idleCloseDue: stale headless without a stream only", async () => {
  assert.equal(idleCloseDue({ headless: true, lastActiveAt: Date.now(), client: {} }), false); // fresh
  assert.equal(idleCloseDue({ headless: false, lastActiveAt: 0, client: {} }), false); // headed never
  assert.equal(idleCloseDue({ headless: true, lastActiveAt: Date.now() - 11 * 60_000, client: {} }), true);
  // A live stream pins the browser open even when fully idle.
  const fakeClient = {
    call: async (method) => (method === "Target.attachToTarget" ? { sessionId: "s-idle" } : {}),
    on: () => () => {}
  };
  await startStream(fakeClient, "idle-pin", { width: 800, height: 600 }, () => {});
  try {
    assert.equal(hasActiveStreamFor(fakeClient), true);
    assert.equal(idleCloseDue({ headless: true, lastActiveAt: 0, client: fakeClient }), false);
  } finally {
    await stopStream("idle-pin");
  }
  assert.equal(hasActiveStreamFor(fakeClient), false);
});

test("e2e: idle close frees the headless Chrome and relaunch restores tabs", async () => {
  if (!resolveChromeBinary()) return; // no local Chromium — skip silently
  const profile = "idletest";
  await removeProfile(profile).catch(() => {}); // clean slate from a prior run
  try {
    createProfile(profile); // engine only launches profiles that exist
    const inst = await getOrLaunchBrowser(profile);
    assert.equal(inst.headless, true);
    const tab = await openTab(profile, "data:text/html,<title>kept</title>idle-restore-marker");
    inst.lastActiveAt = Date.now() - 11 * 60_000; // age past the idle window
    sweepIdleBrowsers();
    for (let i = 0; i < 30 && peekBrowser(profile); i++) await new Promise((r) => setTimeout(r, 300));
    assert.equal(peekBrowser(profile), null, "idle sweep must close the headless browser");
    // Graceful close releases the profile lock async — wait it out or the
    // relaunch forwards to the dying singleton and never opens its port.
    await new Promise((r) => setTimeout(r, 2000));
    await getOrLaunchBrowser(profile);
    const tabs = await listTabs(profile);
    assert.ok(
      tabs.some((t) => String(t.url).includes("idle-restore-marker")),
      `session restored, got: ${tabs.map((t) => t.url).join(", ")}`
    );
    await closeTab(profile, tab.id).catch(() => {});
  } finally {
    await removeProfile(profile).catch(() => {});
  }
});

// ---- stream ack window (binary lane flow control) ----------------------------
function windowRecord(emit) {
  return {
    client: { call: async () => {} },
    size: { width: 512, height: 256 },
    seq: 0, lastSentAt: 0, stopped: false, refs: 1,
    inFlight: new Set(), pendingFrame: null, lastTileChecksums: new Map(), isComparing: false,
    emit
  };
}
// Ack-window tests need frames the stream can decode AND that differ pixel-wise.
const seqFrame = (i) => jpegFrame(512, 256, { x: 8 + i * 24, y: 40, w: 20, h: 20 });
const cdpFrame = () => ({
  data: Buffer.from("fakejpeg").toString("base64"),
  metadata: { deviceWidth: 100, deviceHeight: 50, scrollOffsetX: 0, scrollOffsetY: 0 },
  sessionId: 7
});

test("ack window: emits while room, holds + coalesces when full, flushes on ack", async () => {
  const emitted = [];
  const rec = windowRecord((f) => emitted.push(f.seq));
  await handleFrame(rec, "wt", await seqFrame(0), 1000);  // seq 1
  await handleFrame(rec, "wt", await seqFrame(1), 1100); // seq 2 — window now full
  assert.deepEqual(emitted, [1, 2]);
  await handleFrame(rec, "wt", await seqFrame(2), 1200); // held
  await handleFrame(rec, "wt", await seqFrame(3), 1300); // coalesced: newest replaces it
  assert.deepEqual(emitted, [1, 2], "window full blocks further emits");
  await releaseAck(rec, 1);
  assert.deepEqual(emitted, [1, 2, 3], "ack frees a slot → newest held frame flushes");
  assert.equal(rec.pendingFrame, null);
  assert.deepEqual([...rec.inFlight].sort((a, b) => a - b), [2, 3]);
});

test("ack window: dead acks release the window instead of freezing the stream", async () => {
  const emitted = [];
  const rec = windowRecord((f) => emitted.push(f.seq));
  await handleFrame(rec, "wt", await seqFrame(0), 1000);
  await handleFrame(rec, "wt", await seqFrame(1), 1100);
  await handleFrame(rec, "wt", await seqFrame(2), 5000); // 3.9s since last send > dead window
  assert.deepEqual(emitted, [1, 2, 3], "silent peer must not stall the stream forever");
});

test("ack window: interval floor still drops too-fast frames entirely", async () => {
  const emitted = [];
  const rec = windowRecord((f) => emitted.push(f.seq));
  await handleFrame(rec, "wt", await seqFrame(0), 1000);
  await handleFrame(rec, "wt", await seqFrame(1), 1010); // 10ms < 33ms floor → dropped, not held
  assert.deepEqual(emitted, [1]);
  assert.equal(rec.pendingFrame, null);
});

test("emit throwing must never stall the CDP ack (screencast keeps flowing)", async () => {
  const acked = [];
  const rec = windowRecord(() => { throw new Error("lane down"); });
  rec.client = { call: async (m) => { if (m === "Page.screencastFrameAck") acked.push(m); } };
  const frame = await seqFrame(0);
  await assert.rejects(() => handleFrame(rec, "wt", frame, 1000), /lane down/);
  await assert.rejects(() => handleFrame(rec, "wt", frame, 1100), /lane down/);
  assert.equal(acked.length, 2, "CDP acked BEFORE the emit throw, both times");
});

// ---- tile diffing (flags=1 batches) ------------------------------------------
async function jpegFrame(w, h, blot) {
  let img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 60, g: 70, b: 90 } } });
  if (blot) {
    const overlay = Buffer.from(
      `<svg width="${w}" height="${h}"><rect x="${blot.x}" y="${blot.y}" width="${blot.w}" height="${blot.h}" fill="red"/></svg>`
    );
    img = sharp(await img.jpeg().toBuffer()).composite([{ input: overlay, top: 0, left: 0 }]);
  }
  const buf = await img.jpeg({ quality: 90 }).toBuffer();
  return { data: buf.toString("base64"), metadata: { deviceWidth: w, deviceHeight: h, scrollOffsetX: 0, scrollOffsetY: 0 }, sessionId: 3 };
}

function tileCountOf(payload) {
  if (payload.flags !== 1) return -1;
  return new DataView(payload.image.buffer, payload.image.byteOffset, payload.image.byteLength).getUint32(0, true);
}

test("sendFrame tiles: wholesale change passes Chrome's jpeg through, partial change tiles", async () => {
  const emitted = [];
  const rec = windowRecord((f) => { emitted.push(f); });
  const W = 512, H = 256; // 4×2 grid of 128px tiles

  // First frame = every tile changed → remote desktop pipeline: tiles batch
  const first = await jpegFrame(W, H);
  await handleFrame(rec, "wt", first, 1000);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].flags, 1, "full-change frame goes out as tiles");
  assert.equal(tileCountOf(emitted[0]), 8, "4x2 grid = 8 tiles");
  assert.equal(emitted[0].meta.frameW, W);
  await releaseAck(rec, emitted[0].seq); // client painted — release the window

  // Byte-identical re-emission → skipped without decoding anything.
  await handleFrame(rec, "wt", first, 2000);
  assert.equal(emitted.length, 1, "identical frame sends nothing");

  // A 20×20 blot at (300, 40) touches exactly one 128px tile (index 2: col 2, row 0).
  await handleFrame(rec, "wt", await jpegFrame(W, H, { x: 300, y: 40, w: 20, h: 20 }), 3000);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].flags, 1, "small edit goes out as a tile batch");
  assert.equal(tileCountOf(emitted[1]), 1, "small edit = one tile");
  await releaseAck(rec, emitted[1].seq);

  // Garbage jpeg (undecodable) is dropped and frees its window slot, never throws.
  await handleFrame(rec, "wt", cdpFrame(), 4000);
  assert.equal(emitted.length, 2, "undecodable input emits nothing");
  assert.equal(rec.inFlight.size, 0, "undecodable input releases its ack slot");
});

test("sendFrame tiles: tile hashes stay correct across a passthrough frame", async () => {
  const emitted = [];
  const rec = windowRecord((f) => { emitted.push(f); });
  await handleFrame(rec, "wt", await jpegFrame(512, 256), 1000); // all changed
  await releaseAck(rec, emitted[0].seq);
  await handleFrame(rec, "wt", await jpegFrame(512, 256, { x: 300, y: 40, w: 20, h: 20 }), 2000);
  // The blot frame diffs against the previous pixels: exactly one tile.
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].flags, 1);
  assert.equal(tileCountOf(emitted[1]), 1, "hashes advanced through the previous frame");
});

test("sendFrame tiles: viewport change invalidates the grid", async () => {
  const emitted = [];
  const rec = windowRecord((f) => { emitted.push(f); });
  await handleFrame(rec, "wt", await jpegFrame(512, 256), 1000);
  await releaseAck(rec, emitted[0].seq);
  await handleFrame(rec, "wt", await jpegFrame(512, 256), 2000); // skipped (identical)
  const smaller = await jpegFrame(384, 256);
  await handleFrame(rec, "wt", smaller, 3000); // narrower canvas → grid reset → all changed
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].flags, 1, "post-resize full refresh also goes out as tiles");
  assert.equal(tileCountOf(emitted[1]), 6, "3x2 grid = 6 tiles");
  assert.equal(emitted[1].meta.frameW, 384);
});

// ---- compareClientTileHashes (Remote Desktop request-screen-with-hashes clone) ---
test("compareClientTileHashes: sends exactly the tiles the client claim lacks", async () => {
  const emitted = [];
  const rec = windowRecord((f) => { emitted.push(f); });
  // Full frame delivered at seq 1
  await handleFrame(rec, "vt", await jpegFrame(512, 256), 1000);
  await releaseAck(rec, emitted[0].seq);
  // Blot changes tile 2; delivered at seq 2
  await handleFrame(rec, "vt", await jpegFrame(512, 256, { x: 300, y: 40, w: 20, h: 20 }), 2000);
  await releaseAck(rec, emitted[emitted.length - 1].seq);
  const afterBlot = emitted.length;
  assert.equal(rec.inFlight.size, 0, "everything acked");

  // Client claims hashes where tile 2 is wrong -> compare sends tile 2 only
  const clientHashes = Array.from({ length: 8 }, (_, i) => i === 2 ? 0 : rec.tileHashes.get(i));
  const changed = await compareRecordTileHashes(rec, "vt", clientHashes);
  assert.equal(changed, true, "compare sends the missing tile");
  assert.equal(emitted.length, afterBlot + 1);
  assert.equal(emitted[emitted.length - 1].flags, 1, "repair rides the tile lane");
  assert.equal(tileCountOf(emitted[emitted.length - 1]), 1, "exactly the missing tile");

  // In-sync client -> nothing sent, and no screenshot is ever taken
  const syncHashes = Array.from({ length: 8 }, (_, i) => rec.tileHashes.get(i));
  const idle = await compareRecordTileHashes(rec, "vt", syncHashes);
  assert.equal(idle, false, "in-sync client sends nothing");
  assert.equal(emitted.length, afterBlot + 1);
});

test("compareClientTileHashes: verify never re-captures, empty claim repaints everything", async () => {
  const emitted = [];
  const calls = [];
  const rec = windowRecord((f) => { emitted.push(f); });
  rec.client = { call: async (m) => { calls.push(m); } };
  assert.equal(await compareRecordTileHashes(rec, "vt", [1, 2]), false, "no decoded frame yet -> nothing to compare");

  await handleFrame(rec, "vt", await jpegFrame(512, 256), 1000);
  await releaseAck(rec, emitted[0].seq);
  const claim = Array.from({ length: 8 }, (_, i) => rec.tileHashes.get(i));
  for (let k = 0; k < 3; k++) assert.equal(await compareRecordTileHashes(rec, "vt", claim), false, `verify #${k} stays quiet`);
  assert.ok(!calls.includes("Page.captureScreenshot"), "verify reads the stream frame, not a screenshot");

  assert.equal(await compareRecordTileHashes(rec, "vt", []), true, "empty claim = fresh pane");
  assert.equal(tileCountOf(emitted[emitted.length - 1]), 8, "fresh pane gets the whole grid");
  assert.ok(emitted[emitted.length - 1].dims, "fresh pane is told the size");
});

test("compareClientTileHashes: a stale claim while a frame is in flight sends nothing", async () => {
  const emitted = [];
  const rec = windowRecord((f) => { emitted.push(f); });
  await handleFrame(rec, "vt", await jpegFrame(512, 256), 1000); // not acked yet
  rec.lastSentAt = Date.now();
  assert.equal(rec.inFlight.size, 1);
  const before = emitted.length;
  const stale = Array.from({ length: 8 }, () => 0);
  assert.equal(await compareRecordTileHashes(rec, "vt", stale), false, "tiles still on the wire are not lost tiles");
  assert.equal(emitted.length, before);
});

let failed = 0;
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
